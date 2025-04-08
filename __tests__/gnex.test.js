const Gnex = require("../src/js/gnex.js");

// Mock do fetch
global.fetch = jest.fn();

// Mock do ReadableStream pro SSE e Progresso
if (typeof ReadableStream === "undefined") {
  global.ReadableStream = class ReadableStream {
    constructor(options) {
      this.data = [];
      this.closed = false;
      options.start({
        enqueue: (chunk) => {
          this.data.push(chunk);
        },
        close: () => {
          this.closed = true;
        },
      });
    }
    getReader() {
      let index = 0;
      return {
        read: async () => {
          if (index >= this.data.length) {
            return { done: this.closed, value: undefined };
          }
          await new Promise(resolve => setTimeout(resolve, 5)); // Pequeno atraso pra simular assincronismo
          return { done: false, value: this.data[index++] };
        },
        releaseLock: () => {},
      };
    }
  };
}

// Mock do TextEncoder
if (typeof TextEncoder === "undefined") {
  global.TextEncoder = class TextEncoder {
    encode(str) {
      return new Uint8Array([...str].map(char => char.charCodeAt(0)));
    }
  };
}

// Mock do TextDecoder
if (typeof TextDecoder === "undefined") {
  global.TextDecoder = class TextDecoder {
    decode(buffer) {
      return String.fromCharCode(...buffer);
    }
  };
}

// Função pra criar formulário mockado
function createMockForm(action = "/submit", method = "POST") {
  const form = document.createElement("form");
  form.id = "mock-form"; // Adiciona ID pro seletor funcionar
  form.action = action;
  form.method = method;
  form.innerHTML = '<input name="test" value="value">';
  form.submit = jest.fn();
  return form;
}

// Limpa antes de cada teste
beforeEach(() => {
  fetch.mockClear();
  document.body.innerHTML = "";
  Gnex._responseCache.clear();
  Gnex._abortControllers = new WeakMap();
  Gnex._formConfigs = new WeakMap();
});

// Testes
describe("Gnex.form", () => {
  test("deve lançar erro com selector inválido", () => {
    expect(() => Gnex.form("", {})).toThrow("A valid non-empty selector is required.");
  });

  test("deve avisar se o selector não encontra elementos", () => {
    console.warn = jest.fn();
    Gnex.form("#inexistente", {});
    expect(console.warn).toHaveBeenCalledWith('The selector "#inexistente" does not match any element.');
  });

  test("deve configurar o formulário corretamente", () => {
    document.body.innerHTML = '<form id="test-form"></form>';
    const form = document.querySelector("#test-form");
    Gnex.form("#test-form", {});
    expect(Gnex._formConfigs.has(form)).toBe(true);
  });
});

describe("Submissão síncrona", () => {
  test("deve chamar form.submit() quando async é false", () => {
    const form = createMockForm();
    document.body.appendChild(form);
    Gnex.form("#mock-form", { async: false });
    form.dispatchEvent(new Event("submit"));
    expect(form.submit).toHaveBeenCalled();
  });
});

describe("Submissão assíncrona", () => {
  test("deve fazer fetch com sucesso", async () => {
    const form = createMockForm();
    document.body.appendChild(form);
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => Promise.resolve({ status: "success" }),
    });
    const onSuccess = jest.fn();
    Gnex.form("#mock-form", { async: true, onSuccess });
    await form.dispatchEvent(new Event("submit"));
    await new Promise(process.nextTick); // Aguarda o fetch
    expect(fetch).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith("json", form, { status: "success" });
  });

  test("deve chamar onError em caso de falha", async () => {
    const form = createMockForm();
    document.body.appendChild(form);
    fetch.mockRejectedValue(new Error("Network error"));
    const onError = jest.fn();
    Gnex.form("#mock-form", { async: true, onError });
    await form.dispatchEvent(new Event("submit"));
    await new Promise(process.nextTick); // Aguarda o fetch
    expect(onError).toHaveBeenCalledWith("request", form, "Network error");
  });
});

describe("Validação", () => {
  test("deve impedir submissão se validate retorna false", () => {
    const form = createMockForm();
    document.body.appendChild(form);
    const validate = jest.fn().mockReturnValue(false);
    Gnex.form("#mock-form", { async: true, validate });
    form.dispatchEvent(new Event("submit"));
    expect(validate).toHaveBeenCalledWith(form);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Cache", () => {
  test("deve usar resposta em cache", async () => {
    const form = createMockForm();
    document.body.appendChild(form);
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => Promise.resolve({ cached: true }),
    });
    const onSuccess = jest.fn();
    Gnex.form("#mock-form", { async: true, cache: true, onSuccess });
    await form.dispatchEvent(new Event("submit"));
    await new Promise(process.nextTick); // Aguarda o fetch
    expect(fetch).toHaveBeenCalledTimes(1);
    await form.dispatchEvent(new Event("submit"));
    expect(fetch).toHaveBeenCalledTimes(1); // Não faz novo fetch
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });
});

describe("SSE", () => {
  test("deve processar eventos SSE", async () => {
    const form = createMockForm();
    document.body.appendChild(form);
    const onProgress = jest.fn();
    const onSuccess = jest.fn();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: progress\ndata: 50\n\n"));
        controller.enqueue(new TextEncoder().encode("event: done\ndata: {\"status\":\"success\"}\n\n"));
        controller.close();
      },
    });
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: mockStream,
    });
    Gnex.form("#mock-form", { async: true, sse: true, onProgress, onSuccess });
    await form.dispatchEvent(new Event("submit"));
    await new Promise(resolve => setTimeout(resolve, 50)); // Aumentado pra garantir o processamento
    expect(onProgress).toHaveBeenCalledWith(form, "50");
    expect(onSuccess).toHaveBeenCalledWith("json", form, { status: "success" });
  });
});

describe("Progresso", () => {
  test("deve chamar onProgress durante upload", async () => {
    const form = createMockForm("/upload", "POST");
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    form.innerHTML = '<input type="file" name="file">';
    const input = form.querySelector("input");
    Object.defineProperty(input, "files", {
      value: [file],
      writable: false,
    });
    document.body.appendChild(form);
    const onProgress = jest.fn();

    // Mock específico pro fetch interno do proxyFetch
    jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3])); // Primeira parte: 3 bytes
          controller.enqueue(new Uint8Array([4, 5]));    // Segunda parte: 2 bytes
          controller.close();
        },
      }),
    });

    Gnex.form("#mock-form", { async: true, onProgress });
    await form.dispatchEvent(new Event("submit"));
    await new Promise(resolve => setTimeout(resolve, 200)); // Aguarda o processamento completo
    expect(onProgress).toHaveBeenCalled();
  });
});

describe("Cancelamento", () => {
  test("deve abortar a requisição", async () => {
    const form = createMockForm();
    document.body.appendChild(form);
    fetch.mockImplementation(() => new Promise(() => {})); // Requisição pendente
    Gnex.form("#mock-form", { async: true });
    form.dispatchEvent(new Event("submit"));
    Gnex.cancel(form);
    expect(Gnex._abortControllers.has(form)).toBe(false);
  });
});

describe("Retry", () => {
  test("deve tentar novamente em caso de erro", async () => {
    const form = createMockForm();
    document.body.appendChild(form);
    fetch
      .mockRejectedValueOnce(new Error("Fail 1"))
      .mockRejectedValueOnce(new Error("Fail 2"))
      .mockResolvedValue({
        ok: true,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => Promise.resolve({ status: "success" }),
      });
    const onSuccess = jest.fn();
    Gnex.form("#mock-form", { async: true, retryCount: 2, onSuccess });
    await form.dispatchEvent(new Event("submit"));
    await new Promise(process.nextTick); // Aguarda o fetch
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledWith("json", form, { status: "success" });
  });
});

describe("Gnex.load", () => {
  test("deve carregar conteúdo com sucesso", async () => {
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => Promise.resolve({ loaded: true }),
    });
    const onSuccess = jest.fn();
    const load = Gnex.load("/test", { async: true, onSuccess });
    await new Promise(process.nextTick); // Aguarda o fetch
    expect(fetch).toHaveBeenCalledWith("/test", expect.any(Object));
    expect(onSuccess).toHaveBeenCalledWith("json", null, { loaded: true });
    load.cancel();
  });
});