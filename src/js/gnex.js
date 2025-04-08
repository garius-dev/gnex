/**
 * Gnex - A lightweight AJAX form handler for simple and fast form submissions.
 * @version 1.0.0
 * @author Garius Tech
 */
const Gnex = {
    defaults: {
        async: false,              // Determines if submission uses AJAX
        sse: false,                // Enables Server-Sent Events mode
        timeout: 0,                // Request timeout in milliseconds (0 = no timeout)
        retryCount: 0,             // Number of retries on failure
        headers: {},               // Custom HTTP headers
        onProgress: null,          // Progress callback: (context, progressData) => {}
        setLoadingState: null,     // Loading state setter: (context) => {}
        resetLoadingState: null,   // Loading state resetter: (context) => {}
        onSuccess: null,           // Success callback: (responseType, context, responseData) => {}
        onError: null,             // Error callback: (errorType, context, errorDetails) => {}
        beforeSend: null,          // Pre-request hook: (context, formData, requestOptions) => {}
        cache: false,              // Cache duration (true = indefinite, number = seconds)
        transformData: null,       // Data transformer: (formData) => formData
        validate: null,            // Form validator: (formElement) => true/false
        debug: false,              // Enables debug logging
        method: 'GET'              // Default HTTP method
    },

    _abortControllers: new WeakMap(), // Stores AbortController instances for requests
    _responseCache: new Map(),        // Caches responses for reuse
    _formConfigs: new WeakMap(),      // Stores per-form configurations

    /**
     * Initializes form handling for elements matching the given selector.
     * @param {string} selector - CSS selector for target forms
     * @param {Object} options - Custom configuration overriding defaults
     */
    form(selector, options) {
        if (!selector || typeof selector !== 'string' || selector.trim() === '') {
            throw new Error('A valid non-empty selector is required.');
        }

        const formConfig = { ...this.defaults, ...options };
        const formElements = document.querySelectorAll(selector);

        if (formElements.length === 0) {
            console.warn(`The selector "${selector}" does not match any element.`);
            return;
        }

        formElements.forEach(formElement => this._setupFormHandler(formElement, formConfig));
    },

    /**
     * Configures a form element with submission handling.
     * @param {HTMLFormElement} formElement - The form to handle
     * @param {Object} formConfig - Configuration for this form
     */
    _setupFormHandler(formElement, formConfig) {
        this._formConfigs.set(formElement, formConfig);
        let isProcessing = false;
        let retryAttempts = 0;

        formElement.addEventListener('submit', async (event) => {
            if (isProcessing) {
                event.preventDefault();
                if (formConfig.debug) console.log('[Gnex] Submission already in progress, ignoring.');
                return;
            }

            event.preventDefault();
            isProcessing = true;

            if (formConfig.validate && typeof formConfig.validate === 'function') {
                if (!formConfig.validate(formElement)) {
                    isProcessing = false;
                    if (formConfig.debug) console.log('[Gnex] Validation failed.');
                    return;
                }
            }

            const requestMethod = formElement.method || 'POST';
            let requestData = new FormData(formElement);

            if (formConfig.transformData) {
                requestData = formConfig.transformData(requestData) || requestData;
                if (formConfig.debug) console.log('[Gnex] FormData transformed:', requestData);
            }

            const abortController = new AbortController();
            this._abortControllers.set(formElement, abortController);

            const requestOptions = {
                method: requestMethod,
                body: requestData,
                headers: formConfig.headers,
                signal: abortController.signal,
                redirect: 'manual'
            };

            if (formConfig.beforeSend && formConfig.beforeSend(formElement, requestData, requestOptions) === false) {
                isProcessing = false;
                if (formConfig.resetLoadingState) formConfig.resetLoadingState(formElement);
                if (formConfig.debug) console.log('[Gnex] Submission cancelled by beforeSend.');
                return;
            }

            if (formConfig.setLoadingState) formConfig.setLoadingState(formElement);

            if (!formConfig.async) {
                if (formConfig.debug) console.log('[Gnex] Submitting form synchronously.');
                formElement.submit();
                return;
            }

            const cacheKey = `${requestMethod}:${formElement.action}:${JSON.stringify([...requestData.entries()])}`;
            if (formConfig.cache && this._responseCache.has(cacheKey)) {
                const cachedResponse = this._responseCache.get(cacheKey);
                if (Date.now() < cachedResponse.expires) {
                    if (formConfig.debug) console.log('[Gnex] Serving from cache:', cachedResponse.data);
                    if (formConfig.onSuccess) formConfig.onSuccess(cachedResponse.responseType, formElement, cachedResponse.data);
                    isProcessing = false;
                    if (formConfig.resetLoadingState) formConfig.resetLoadingState(formElement);
                    return;
                } else {
                    this._responseCache.delete(cacheKey);
                }
            }

            const executeSubmission = async () => {
                try {
                    if (formConfig.debug) console.log('[Gnex] Starting submission:', { method: requestMethod, action: formElement.action });

                    const timeoutSignal = formConfig.timeout > 0 ? AbortSignal.timeout(formConfig.timeout) : null;
                    const combinedSignal = timeoutSignal ? AbortSignal.any([abortController.signal, timeoutSignal]) : abortController.signal;

                    const response = await fetch(formElement.action, { ...requestOptions, signal: combinedSignal });

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const contentType = response.headers.get('Content-Type') || '';
                    let responseType, responseData;

                    if (formConfig.sse && contentType.includes('text/event-stream')) {
                        await this._processSseStream(response, formElement, formConfig);
                        return;
                    }

                    if (contentType.startsWith('application/json')) {
                        responseType = 'json';
                        responseData = await response.json();
                    } else if (response.headers.get('X-Partial-View') === 'true') {
                        responseType = 'x-html';
                        responseData = await response.text();
                    } else if (response.status >= 300 && response.status < 400) {
                        responseType = 'redirect';
                        responseData = response.headers.get('Location') || 'unknown';
                    } else {
                        responseType = 'full-html';
                        responseData = await response.text();
                    }

                    if (!formConfig.sse && responseType && responseData) {
                        if (formConfig.cache) {
                            const expires = typeof formConfig.cache === 'number' ? Date.now() + formConfig.cache * 1000 : Infinity;
                            this._responseCache.set(cacheKey, { responseType, data: responseData, expires });
                            if (formConfig.debug) console.log('[Gnex] Cached response:', { responseType, responseData });
                        }
                        if (formConfig.onSuccess) formConfig.onSuccess(responseType, formElement, responseData);
                        if (formConfig.debug) console.log('[Gnex] Success:', { responseType, responseData });
                    }
                } catch (error) {
                    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
                        if (formConfig.onError) formConfig.onError(error.name === 'TimeoutError' ? 'timeout' : 'aborted', formElement, error);
                        if (formConfig.debug) console.log('[Gnex] Error:', error.name);
                        return;
                    }

                    if (retryAttempts < formConfig.retryCount) {
                        retryAttempts++;
                        if (formConfig.debug) console.log(`[Gnex] Retry attempt ${retryAttempts}/${formConfig.retryCount}`);
                        await executeSubmission();
                        return;
                    }

                    if (formConfig.onError) formConfig.onError('request', formElement, error.message);
                    if (formConfig.debug) console.log('[Gnex] Error:', error.message);
                } finally {
                    isProcessing = false;
                    this._abortControllers.delete(formElement);
                    if (formConfig.resetLoadingState) formConfig.resetLoadingState(formElement);
                }
            };

            if (formConfig.onProgress && requestData.hasFiles() && !formConfig.sse) {
                await this._handleProgressTracking(formElement, formConfig, requestOptions, executeSubmission);
            } else {
                await executeSubmission();
            }
        });
    },

    /**
     * Processes Server-Sent Events from a response stream.
     * @param {Response} response - Fetch response object
     * @param {HTMLFormElement} formElement - The form context
     * @param {Object} formConfig - Configuration object
     */
    _processSseStream(response, formElement, formConfig) {
        const reader = response.body.getReader();
        let eventBuffer = '';

        return new Promise(resolve => {
            const processStream = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    eventBuffer += new TextDecoder().decode(value);
                    const events = eventBuffer.split('\n\n');

                    for (let i = 0; i < events.length - 1; i++) {
                        const eventText = events[i].trim();
                        if (!eventText) continue;

                        const lines = eventText.split('\n');
                        let eventType = 'message';
                        let dataLines = [];

                        for (const line of lines) {
                            if (line.startsWith('event:')) {
                                eventType = line.slice(6).trim();
                            } else if (line.startsWith('data:')) {
                                dataLines.push(line.slice(5));
                            }
                        }

                        const eventData = dataLines.join('\n').trim();
                        if (!eventData) continue;

                        if (formConfig.debug) console.log(`[Gnex] SSE Event: ${eventType}`, eventData);

                        switch (eventType) {
                            case 'progress':
                                if (formConfig.onProgress) formConfig.onProgress(formElement, eventData);
                                break;
                            case 'done':
                                try {
                                    const jsonData = JSON.parse(eventData);
                                    if (formConfig.onSuccess) formConfig.onSuccess('json', formElement, jsonData);
                                } catch (e) {
                                    if (formConfig.debug) console.warn('[Gnex] SSE JSON Parse Error:', e);
                                    if (formConfig.onError) formConfig.onError('sse-parse', formElement, e);
                                }
                                break;
                            default:
                                if (formConfig.debug) console.log(`[Gnex] Unhandled SSE event: ${eventType}`, eventData);
                                break;
                        }
                    }

                    eventBuffer = events[events.length - 1];
                }

                if (eventBuffer.trim()) {
                    this._processFinalSseEvent(eventBuffer, formElement, formConfig);
                }
                resolve();
            };

            processStream();
        });
    },

    /**
     * Handles any remaining SSE event after stream ends.
     * @param {string} eventBuffer - Remaining buffer content
     * @param {HTMLFormElement} formElement - The form context
     * @param {Object} formConfig - Configuration object
     */
    _processFinalSseEvent(eventBuffer, formElement, formConfig) {
        const lines = eventBuffer.split('\n');
        let eventType = 'message';
        let dataLines = [];

        for (const line of lines) {
            if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5));
            }
        }

        const eventData = dataLines.join('\n').trim();
        if (eventData) {
            if (formConfig.debug) console.log(`[Gnex] SSE Final Event: ${eventType}`, eventData);
            switch (eventType) {
                case 'progress':
                    if (formConfig.onProgress) formConfig.onProgress(formElement, eventData);
                    break;
                case 'done':
                    try {
                        const jsonData = JSON.parse(eventData);
                        if (formConfig.onSuccess) formConfig.onSuccess('json', formElement, jsonData);
                    } catch (e) {
                        if (formConfig.debug) console.warn('[Gnex] SSE JSON Parse Error:', e);
                        if (formConfig.onError) formConfig.onError('sse-parse', formElement, e);
                    }
                    break;
                default:
                    if (formConfig.debug) console.log(`[Gnex] Unhandled SSE final event: ${eventType}`, eventData);
                    break;
            }
        }
    },

    /**
     * Tracks upload progress for forms with files.
     * @param {HTMLFormElement} formElement - The form context
     * @param {Object} formConfig - Configuration object
     * @param {Object} requestOptions - Fetch options
     * @param {Function} executeSubmission - Submission function
     */
    _handleProgressTracking(formElement, formConfig, requestOptions, executeSubmission) {
        const totalSize = [...requestOptions.body.entries()].reduce((acc, [_, value]) => acc + (value.size || 0), 0);
        if (totalSize <= 0) return executeSubmission();

        let uploadedBytes = 0;
        const proxyFetch = async () => {
            const response = await fetch(formElement.action, requestOptions);
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                uploadedBytes += value.length;
                const progressPercent = Math.min(100, Math.round((uploadedBytes / totalSize) * 100));
                formConfig.onProgress(formElement, progressPercent);
                if (formConfig.debug) console.log('[Gnex] Upload progress:', progressPercent + '%');
            }
            return response;
        };

        requestOptions.signal = null;
        return proxyFetch().then(response => {
            requestOptions.signal = this._abortControllers.get(formElement).signal;
            Object.defineProperty(response, 'body', { value: response.body });
            return executeSubmission();
        });
    },

    /**
     * Performs a standalone AJAX request.
     * @param {string} url - Target URL
     * @param {Object} options - Custom configuration
     * @returns {Object} Control object with cancel method
     */
    load(url, options = {}) {
        const requestConfig = { ...this.defaults, ...options, async: true };
        const abortController = new AbortController();
        const requestId = `gnex-load-${Date.now()}`;
        const requestContext = { id: requestId };

        this._abortControllers.set(requestContext, abortController);

        const requestOptions = {
            method: requestConfig.method,
            headers: requestConfig.headers,
            signal: abortController.signal,
            redirect: 'manual'
        };

        if (requestConfig.beforeSend && requestConfig.beforeSend(null, null, requestOptions) === false) {
            if (requestConfig.resetLoadingState) requestConfig.resetLoadingState(null);
            if (requestConfig.debug) console.log('[Gnex] Load cancelled by beforeSend.');
            return { cancel: () => this.cancel(requestContext) };
        }

        (async () => {
            try {
                if (requestConfig.setLoadingState) requestConfig.setLoadingState(null);

                const response = await fetch(url, requestOptions);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const contentType = response.headers.get('Content-Type') || '';
                let responseType, responseData;

                if (requestConfig.sse && contentType.includes('text/event-stream')) {
                    await this._processSseStream(response, null, requestConfig);
                    return;
                }

                if (contentType.includes('application/json')) {
                    responseType = 'json';
                    responseData = await response.json();
                } else if (response.headers.get('X-Partial-View') === 'true') {
                    responseType = 'x-html';
                    responseData = await response.text();
                } else {
                    responseType = 'text';
                    responseData = await response.text();
                }

                if (requestConfig.onSuccess) requestConfig.onSuccess(responseType, null, responseData);
            } catch (error) {
                if (requestConfig.onError) requestConfig.onError('request', null, error);
            } finally {
                this._abortControllers.delete(requestContext);
                if (requestConfig.resetLoadingState) requestConfig.resetLoadingState(null);
            }
        })();

        return { cancel: () => this.cancel(requestContext) };
    },

    /**
     * Cancels an ongoing request.
     * @param {Object|HTMLFormElement} context - Form element or request context
     */
    cancel(context) {
        const controller = this._abortControllers.get(context);
        if (controller) {
            controller.abort();
            this._abortControllers.delete(context);
        }
    },

    /**
     * Triggers success callback for a form.
     * @param {HTMLFormElement} formElement - The form context
     * @param {string} responseType - Type of response
     * @param {any} responseData - Response data
     */
    _handleSuccess(formElement, responseType, responseData) {
        const config = this._formConfigs.get(formElement) || this.defaults;
        if (config.onSuccess) config.onSuccess(responseType, formElement, responseData);
    },

    /**
     * Triggers error callback for a form.
     * @param {HTMLFormElement} formElement - The form context
     * @param {string} errorType - Type of error
     * @param {any} errorDetails - Error details
     */
    _handleError(formElement, errorType, errorDetails) {
        const config = this._formConfigs.get(formElement) || this.defaults;
        if (config.onError) config.onError(errorType, formElement, errorDetails);
    }
};

/**
 * Checks if FormData contains files.
 * @returns {boolean} True if files are present
 */
FormData.prototype.hasFiles = function () {
    return [...this.values()].some(value => value instanceof File || value instanceof Blob);
};