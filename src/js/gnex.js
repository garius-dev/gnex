/**
 * Gnex - A lightweight AJAX form handler for simple and fast form submissions.
 * @version 1.0.0
 * @author Garius Tech
 */
const Gnex = {
    defaults: {
        async: false,              // Enable AJAX behavior
        sse: false,                // Enable Server-Sent Events mode
        timeout: 0,                // Request timeout in milliseconds (0 = no timeout)
        retryCount: 0,             // Number of retries on failure
        headers: {},               // Custom headers
        onProgress: null,          // Callback for progress: (form, data) => {}
        setLoadingState: null,     // Callback to apply loading state: (form) => {}
        resetLoadingState: null,   // Callback to reset loading state: (form) => {}
        onSuccess: null,           // Success callback: (type, form, data) => {}
        onError: null,             // Error callback: (type, form, error) => {}
        beforeSend: null,          // Callback before sending: (form, formData, fetchOptions) => {}
        cache: false,              // Cache response (true = indefinite, number = seconds)
        transformData: null,       // Transform formData: (formData) => formData
        validate: null,            // Validation function: (form) => true/false
        debug: false               // Enable debug logs
    },

    _controllers: new WeakMap(),
    _cache: new Map(),
    _configs: new WeakMap(),

    init(selector, options) {
        if (!selector || typeof selector !== 'string' || selector.trim() === '') {
            throw new Error('A valid non-empty selector is required.');
        }

        const config = { ...this.defaults, ...options };
        const forms = document.querySelectorAll(selector);

        if (forms.length === 0) {
            console.warn(`The selector "${selector}" does not match any element.`);
            return;
        }

        forms.forEach(form => this.setupForm(form, config));
    },

    setupForm(form, config) {
        this._configs.set(form, config);
        let isSubmitting = false;
        let retryAttempts = 0;

        form.addEventListener('submit', async (e) => {
            if (isSubmitting) {
                e.preventDefault();
                if (config.debug) console.log('[Gnex] Submission already in progress, ignoring.');
                return;
            }

            e.preventDefault();
            isSubmitting = true;

            // Validação opcional
            if (config.validate && typeof config.validate === 'function') {
                if (!config.validate(form)) {
                    isSubmitting = false;
                    if (config.debug) console.log('[Gnex] Validation failed.');
                    return;
                }
            }

            const method = form.method || 'POST';
            let formData = new FormData(form);

            if (config.transformData) {
                formData = config.transformData(formData) || formData;
                if (config.debug) console.log('[Gnex] FormData transformed:', formData);
            }

            const abortController = new AbortController();
            this._controllers.set(form, abortController);

            const fetchOptions = {
                method,
                body: formData,
                headers: config.headers,
                signal: abortController.signal,
                redirect: 'manual'
            };

            if (config.beforeSend && config.beforeSend(form, formData, fetchOptions) === false) {
                isSubmitting = false;
                if (config.resetLoadingState) config.resetLoadingState(form);
                if (config.debug) console.log('[Gnex] Submission cancelled by beforeSend.');
                return;
            }

            if (config.setLoadingState) config.setLoadingState(form);

            if (!config.async) {
                if (config.debug) console.log('[Gnex] Submitting form synchronously.');
                form.submit();
                return;
            }

            const cacheKey = `${method}:${form.action}:${JSON.stringify([...formData.entries()])}`;
            if (config.cache && this._cache.has(cacheKey)) {
                const cached = this._cache.get(cacheKey);
                if (Date.now() < cached.expires) {
                    if (config.debug) console.log('[Gnex] Serving from cache:', cached.data);
                    if (config.onSuccess) config.onSuccess(cached.type, form, cached.data);
                    isSubmitting = false;
                    if (config.resetLoadingState) config.resetLoadingState(form);
                    return;
                } else {
                    this._cache.delete(cacheKey);
                }
            }

            const submitForm = async () => {
                try {
                    if (config.debug) console.log('[Gnex] Starting submission:', { method, action: form.action });

                    const timeoutSignal = config.timeout > 0 ? AbortSignal.timeout(config.timeout) : null;
                    const combinedSignal = timeoutSignal ? AbortSignal.any([abortController.signal, timeoutSignal]) : abortController.signal;

                    const response = await fetch(form.action, { ...fetchOptions, signal: combinedSignal });

                    if (!response.ok) throw new Error(`HTTP ${response.status}`);

                    const contentType = response.headers.get('Content-Type') || '';

                    // Novo tratamento SSE, robusto e profissional
                    if (config.sse && contentType.includes('text/event-stream')) {
                        const reader = response.body.getReader();
                        let buffer = ''; // Buffer para acumular dados do stream

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break; // Stream encerrado

                            // Converte os bytes recebidos em texto e adiciona ao buffer
                            buffer += new TextDecoder().decode(value);

                            // Divide o buffer em eventos completos (separados por \n\n)
                            const events = buffer.split('\n\n');
                            for (let i = 0; i < events.length - 1; i++) {
                                const eventText = events[i].trim();
                                if (!eventText) continue; // Ignora eventos vazios

                                // Parseia o evento SSE
                                const lines = eventText.split('\n');
                                let eventType = 'message'; // Padrão W3C se "event" não for especificado
                                let dataLines = [];

                                for (const line of lines) {
                                    if (line.startsWith('event:')) {
                                        eventType = line.slice(6).trim(); // Extrai o tipo de evento
                                    } else if (line.startsWith('data:')) {
                                        dataLines.push(line.slice(5)); // Acumula linhas de dados
                                    }
                                    // Nota: Campos como "id" ou "retry" podem ser adicionados aqui no futuro
                                }

                                const data = dataLines.join('\n').trim(); // Junta os dados com quebras de linha
                                if (!data) continue; // Ignora se não houver dados

                                if (config.debug) console.log(`[Gnex] SSE Event: ${eventType}`, data);

                                // Processa o evento com base no tipo
                                switch (eventType) {
                                    case 'progress':
                                        if (config.onProgress) config.onProgress(form, data);
                                        break;
                                    case 'done':
                                        try {
                                            const jsonData = JSON.parse(data); // Espera JSON no evento "done"
                                            if (config.onSuccess) config.onSuccess('json', form, jsonData);
                                        } catch (e) {
                                            if (config.debug) console.warn('[Gnex] SSE JSON Parse Error:', e);
                                            if (config.onError) config.onError('sse-parse', form, e);
                                        }
                                        break;
                                    default:
                                        if (config.debug) console.log(`[Gnex] Unhandled SSE event: ${eventType}`, data);
                                        // Não dispara erro, apenas loga evento desconhecido
                                        break;
                                }
                            }

                            // O último pedaço pode estar incompleto, mantém no buffer
                            buffer = events[events.length - 1];
                        }

                        // Processa qualquer evento restante no buffer após o stream encerrar
                        if (buffer.trim()) {
                            const lines = buffer.split('\n');
                            let eventType = 'message';
                            let dataLines = [];

                            for (const line of lines) {
                                if (line.startsWith('event:')) {
                                    eventType = line.slice(6).trim();
                                } else if (line.startsWith('data:')) {
                                    dataLines.push(line.slice(5));
                                }
                            }

                            const data = dataLines.join('\n').trim();
                            if (data) {
                                if (config.debug) console.log(`[Gnex] SSE Final Event: ${eventType}`, data);
                                switch (eventType) {
                                    case 'progress':
                                        if (config.onProgress) config.onProgress(form, data);
                                        break;
                                    case 'done':
                                        try {
                                            const jsonData = JSON.parse(data);
                                            if (config.onSuccess) config.onSuccess('json', form, jsonData);
                                        } catch (e) {
                                            if (config.debug) console.warn('[Gnex] SSE JSON Parse Error:', e);
                                            if (config.onError) config.onError('sse-parse', form, e);
                                        }
                                        break;
                                    default:
                                        if (config.debug) console.log(`[Gnex] Unhandled SSE final event: ${eventType}`, data);
                                        break;
                                }
                            }
                        }

                        return; // Encerra após processar o stream SSE
                    }

                    // Respostas normais (mantidas exatamente como no original)
                    else if (contentType.startsWith('application/json')) {
                        type = 'json';
                        data = await response.json();
                    } else if (response.headers.get('X-Partial-View') === 'true') {
                        type = 'x-html';
                        data = await response.text();
                    } else if (response.status >= 300 && response.status < 400) {
                        type = 'redirect';
                        data = response.headers.get('Location') || 'unknown';
                    } else {
                        type = 'full-html';
                        data = await response.text();
                    }

                    if (!config.sse && type && data) {
                        if (config.cache) {
                            const expires = typeof config.cache === 'number' ? Date.now() + config.cache * 1000 : Infinity;
                            this._cache.set(cacheKey, { type, data, expires });
                            if (config.debug) console.log('[Gnex] Cached response:', { type, data });
                        }
                        if (config.onSuccess) config.onSuccess(type, form, data);
                        if (config.debug) console.log('[Gnex] Success:', { type, data });
                    }
                } catch (error) {
                    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
                        if (config.onError) config.onError(error.name === 'TimeoutError' ? 'timeout' : 'aborted', form, error);
                        if (config.debug) console.log('[Gnex] Error:', error.name);
                        return;
                    }

                    if (retryAttempts < config.retryCount) {
                        retryAttempts++;
                        if (config.debug) console.log(`[Gnex] Retry attempt ${retryAttempts}/${config.retryCount}`);
                        await submitForm();
                        return;
                    }

                    if (config.onError) config.onError('request', form, error);
                    if (config.debug) console.log('[Gnex] Error:', error);
                } finally {
                    isSubmitting = false;
                    this._controllers.delete(form);
                    if (config.resetLoadingState) config.resetLoadingState(form);
                }
            };

            if (config.onProgress && formData.hasFiles() && !config.sse) {
                const totalSize = [...formData.entries()].reduce((acc, [key, value]) => acc + (value.size || 0), 0);
                if (totalSize > 0) {
                    let loaded = 0;
                    const proxyFetch = async () => {
                        const response = await fetch(form.action, fetchOptions);
                        const reader = response.body.getReader();
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            loaded += value.length;
                            const percent = Math.min(100, Math.round((loaded / totalSize) * 100));
                            config.onProgress(form, percent);
                            if (config.debug) console.log('[Gnex] Upload progress:', percent + '%');
                        }
                        return response;
                    };
                    fetchOptions.signal = null;
                    const response = await proxyFetch();
                    fetchOptions.signal = abortController.signal;
                    Object.defineProperty(response, 'body', { value: response.body });
                    await submitForm();
                } else {
                    await submitForm();
                }
            } else {
                await submitForm();
            }
        });
    },

    cancel(form) {
        const controller = this._controllers.get(form);
        if (controller) {
            controller.abort();
            this._controllers.delete(form);
        }
    },

    _handleSuccess(form, type, data) {
        const config = this._configs.get(form) || this.defaults;
        if (config.onSuccess) config.onSuccess(type, form, data);
    },

    _handleError(form, type, error) {
        const config = this._configs.get(form) || this.defaults;
        if (config.onError) config.onError(type, form, error);
    }
};

FormData.prototype.hasFiles = function () {
    return [...this.values()].some(value => value instanceof File || value instanceof Blob);
};