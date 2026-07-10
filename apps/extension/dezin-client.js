const DEFAULT_URL = "http://127.0.0.1:7457";
const CREDENTIAL_KEY = "dezinCredential";

function errorMessage(data, fallback) {
  return data && typeof data.error === "string" ? data.error : fallback;
}

export function createDezinClient(options = {}) {
  const chromeApi = options.chromeApi ?? globalThis.chrome;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function baseUrl() {
    const { dezinUrl } = await chromeApi.storage.sync.get("dezinUrl");
    return String(dezinUrl || DEFAULT_URL).replace(/\/+$/, "");
  }

  async function credential() {
    const result = await chromeApi.storage.local.get(CREDENTIAL_KEY);
    return result[CREDENTIAL_KEY] ?? null;
  }

  async function forget() {
    await chromeApi.storage.local.remove(CREDENTIAL_KEY);
  }

  async function pair(code) {
    const response = await fetchImpl(`${await baseUrl()}/api/extension/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: String(code).trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token || !data.credential) {
      throw new Error(errorMessage(data, `Pairing failed (${response.status})`));
    }
    const paired = { token: data.token, credential: data.credential };
    await chromeApi.storage.local.set({ [CREDENTIAL_KEY]: paired });
    return paired;
  }

  async function authorizedPost(path, body) {
    const paired = await credential();
    if (!paired?.token) throw new Error("Pair the extension with Dezin first.");
    const response = await fetchImpl(`${await baseUrl()}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${paired.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) await forget();
    if (!response.ok) throw new Error(errorMessage(data, `Dezin daemon returned ${response.status}`));
    return data;
  }

  return {
    pair,
    capture: (payload) => authorizedPost("/api/capture", payload),
    analyze: (payload) => authorizedPost("/api/analyze-image", payload),
    forget,
  };
}

function defaultClient() {
  return createDezinClient();
}

export const pair = (...args) => defaultClient().pair(...args);
export const capture = (...args) => defaultClient().capture(...args);
export const analyze = (...args) => defaultClient().analyze(...args);
export const forget = (...args) => defaultClient().forget(...args);
