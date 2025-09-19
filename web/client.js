const STORAGE_PREFIX = "seedinter";
const SESSION_TOKEN_KEY = `${STORAGE_PREFIX}.sessionToken`;
const PROVIDER_SELECTION_KEY = `${STORAGE_PREFIX}.provider.selected`;
const PROVIDER_KEYS_KEY = `${STORAGE_PREFIX}.provider.keys`;

class SessionManager {
  constructor() {
    this.token = window.localStorage.getItem(SESSION_TOKEN_KEY) || null;
    this.user = null;
    this.providers = [];
    this.defaultProvider = "fal";
  }

  get isAuthenticated() {
    return Boolean(this.user && this.token);
  }

  setToken(token) {
    this.token = token;
    if (token) {
      window.localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  }

  async refresh() {
    const response = await fetch("/api/auth/session", {
      headers: this._headers(),
    });
    if (!response.ok) {
      throw new Error(`Session check failed: ${response.status}`);
    }
    const data = await response.json();
    this.user = data.user;
    this.providers = Array.isArray(data.providers) ? data.providers : [];
    this.defaultProvider = typeof data.defaultProvider === "string" ? data.defaultProvider : this.defaultProvider;
    return data;
  }

  async login(username, password) {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || response.statusText || "Login failed.");
    }
    this.setToken(data.token);
    this.user = data.user;
    await this.refresh();
    return data.user;
  }

  async register(username, password) {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (response.status >= 400) {
      throw new Error(data?.error?.message || response.statusText || "Registration failed.");
    }
    this.setToken(data.token);
    this.user = data.user;
    await this.refresh();
    return data.user;
  }

  async logout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: this._headers(),
      });
    } catch (error) {
      console.warn("Logout request failed", error);
    }
    this.setToken(null);
    this.user = null;
    return this.refresh().catch(() => null);
  }

  _headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.token) {
      headers["X-Session-Token"] = this.token;
    }
    return headers;
  }
}

class ProviderStore {
  constructor(sessionManager) {
    this.session = sessionManager;
    this.selected = window.localStorage.getItem(PROVIDER_SELECTION_KEY) || sessionManager.defaultProvider;
    try {
      const stored = window.localStorage.getItem(PROVIDER_KEYS_KEY);
      this.keys = stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.warn("Failed to parse provider key cache", error);
      this.keys = {};
    }
  }

  setProviders(list, fallback) {
    if (Array.isArray(list) && list.length) {
      this.providers = list;
    } else {
      this.providers = [fallback];
    }
    if (!this.providers.includes(this.selected)) {
      this.selected = fallback;
      window.localStorage.setItem(PROVIDER_SELECTION_KEY, this.selected);
    }
  }

  getSelected() {
    return this.selected;
  }

  setSelected(provider) {
    if (typeof provider === "string" && provider) {
      this.selected = provider;
      window.localStorage.setItem(PROVIDER_SELECTION_KEY, provider);
    }
  }

  getKey(provider) {
    return typeof this.keys?.[provider] === "string" ? this.keys[provider] : "";
  }

  setKey(provider, value) {
    if (!provider) {
      return;
    }
    if (value) {
      this.keys[provider] = value;
    } else {
      delete this.keys[provider];
    }
    window.localStorage.setItem(PROVIDER_KEYS_KEY, JSON.stringify(this.keys));
  }
}

class ApiClient {
  constructor(sessionManager) {
    this.session = sessionManager;
  }

  async request(path, { method = "GET", headers = {}, body, signal } = {}) {
    const init = { method, headers: { ...headers }, signal };
    if (body !== undefined) {
      if (body instanceof FormData || typeof body === "string") {
        init.body = body;
      } else {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
    }
    if (this.session.token) {
      init.headers["X-Session-Token"] = this.session.token;
    }
    const response = await fetch(path, init);
    return response;
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error("Unable to parse server response.");
    }
    if (!response.ok) {
      const message = payload?.error?.message || response.statusText || "Request failed.";
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}

export const sessionManager = new SessionManager();
export const apiClient = new ApiClient(sessionManager);
export const providerStore = new ProviderStore(sessionManager);

export async function bootstrapServices() {
  const data = await sessionManager.refresh().catch((error) => {
    console.warn("Session refresh failed", error);
    return { providers: [], defaultProvider: sessionManager.defaultProvider };
  });
  providerStore.setProviders(data.providers || [sessionManager.defaultProvider], sessionManager.defaultProvider);
  return data;
}

export function buildTaskPayload({ provider, application, arguments: args, apiKey }) {
  const payload = {
    provider,
    application,
    arguments: args,
  };
  if (apiKey) {
    payload.credentials = {
      [provider]: { apiKey },
    };
  }
  return payload;
}

