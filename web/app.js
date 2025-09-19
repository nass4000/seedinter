import { apiClient, bootstrapServices, buildTaskPayload, providerStore, sessionManager } from "./client.js";

const API_BASE = "/api/tasks";
const HISTORY_LIMIT = 15;
const MAX_LOG_ENTRIES = 200;
const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024;
const AUTH_MODES = { login: "login", register: "register" };

const statusLabels = {
  queued: "Queued",
  running: "Running",
  cancelled: "Cancelled",
  succeeded: "Succeeded",
  failed: "Failed"
};

const elements = {
  form: document.getElementById("generation-form"),
  provider: document.getElementById("provider"),
  providerKey: document.getElementById("provider-key"),
  application: document.getElementById("application"),
  prompt: document.getElementById("prompt"),
  resolution: document.getElementById("resolution"),
  aspectRatio: document.getElementById("aspect-ratio"),
  duration: document.getElementById("duration"),
  cameraFixed: document.getElementById("camera-fixed"),
  safetyChecker: document.getElementById("safety-checker"),
  seed: document.getElementById("seed"),
  imageInput: document.getElementById("image-input"),
  imageUrl: document.getElementById("image-url"),
  imagePreview: document.getElementById("image-preview"),
  previewImage: document.getElementById("preview-image"),
  clearImage: document.getElementById("clear-image"),
  pollInterval: document.getElementById("poll-interval"),
  submitButton: document.getElementById("submit-button"),
  cancelPoll: document.getElementById("cancel-poll"),
  taskInfo: document.getElementById("task-info"),
  log: document.getElementById("log"),
  resultVideo: document.getElementById("result-video"),
  historyList: document.getElementById("history-list"),
  authForm: document.getElementById("auth-form"),
  authUsername: document.getElementById("auth-username"),
  authPassword: document.getElementById("auth-password"),
  authSubmit: document.getElementById("auth-submit"),
  authToggle: document.getElementById("auth-toggle"),
  authError: document.getElementById("auth-error"),
  authStatus: document.getElementById("auth-status"),
  authUser: document.getElementById("auth-user"),
  authLogout: document.getElementById("auth-logout")
};

const state = {
  imageDataUrl: null,
  logEntries: [],
  seenLogEntries: new Set(),
  pollController: null,
  pollTimeoutId: null,
  currentApplication: null,
  currentProvider: providerStore.getSelected(),
  history: [],
  taskCache: new Map(),
  authMode: AUTH_MODES.login
};

function logMessage(message, level = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const prefix =
    level === "error"
      ? "ERR"
      : level === "success"
      ? "OK "
      : level === "warn"
      ? "WRN"
      : "INF";
  const entry = `[${timestamp}] ${prefix} ${message}`;
  state.logEntries.push(entry);
  if (state.logEntries.length > MAX_LOG_ENTRIES) {
    state.logEntries.shift();
  }
  elements.log.textContent = state.logEntries.join("\n");
  elements.log.scrollTop = elements.log.scrollHeight;
}

function escapeHtml(value) {
  return value
    ? value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
    : "";
}

function formatTimestamp(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    return String(value);
  }
}

function getVideoUrl(task) {
  if (task?.content?.video_url) {
    return task.content.video_url;
  }
  if (task?.result?.video?.url) {
    return task.result.video.url;
  }
  return null;
}

function setVideoUrl(url) {
  if (url) {
    elements.resultVideo.src = url;
    elements.resultVideo.classList.remove("hidden");
  } else {
    elements.resultVideo.removeAttribute("src");
    elements.resultVideo.classList.add("hidden");
  }
}

function setBusy(isBusy) {
  elements.submitButton.disabled = isBusy;
  elements.form.classList.toggle("is-busy", isBusy);
  elements.form.setAttribute("aria-busy", isBusy ? "true" : "false");
}

function resetTaskState() {
  renderTaskInfo(null);
  setVideoUrl(null);
  state.logEntries = [];
  elements.log.textContent = "";
  state.seenLogEntries = new Set();
}

function stopPolling(clearStatus = false) {
  if (state.pollTimeoutId) {
    clearTimeout(state.pollTimeoutId);
    state.pollTimeoutId = null;
  }
  if (state.pollController) {
    state.pollController.abort();
    state.pollController = null;
  }
  elements.cancelPoll.disabled = true;
  if (clearStatus) {
    elements.cancelPoll.classList.add("hidden");
  }
}

function ingestLogs(logs) {
  if (!Array.isArray(logs)) return;
  logs.forEach((entry) => {
    if (!entry) return;
    const message = typeof entry.message === "string" ? entry.message : JSON.stringify(entry);
    const key = `${entry.id ?? ""}-${message}`;
    if (state.seenLogEntries.has(key)) return;
    state.seenLogEntries.add(key);
    const level = typeof entry.level === "string" ? entry.level.toLowerCase() : "info";
    const logLevel =
      level.includes("error")
        ? "error"
        : level.includes("warn")
        ? "warn"
        : level.includes("success")
        ? "success"
        : "info";
    logMessage(message, logLevel);
  });
}

function cacheTask(task) {
  if (!task || !task.id) return;
  state.taskCache.set(task.id, task);
  const entry = {
    id: task.id,
    provider: task.provider || state.currentProvider,
    application: task.application || state.currentApplication || "",
    status: task.status || "unknown",
    created_by: task.created_by || null,
    created_at: task.created_at || null,
    updated_at: task.updated_at || new Date().toISOString(),
    videoUrl: getVideoUrl(task)
  };
  const index = state.history.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    state.history[index] = { ...state.history[index], ...entry };
  } else {
    state.history.unshift(entry);
    if (state.history.length > HISTORY_LIMIT) {
      state.history.length = HISTORY_LIMIT;
    }
  }
  renderHistory();
}

function renderTaskInfo(task) {
  if (!task) {
    elements.taskInfo.innerHTML = "<p>No task submitted yet.</p>";
    return;
  }

  const parts = [];
  if (task.id) {
    parts.push(`<p><strong>Task ID:</strong> <code>${escapeHtml(task.id)}</code></p>`);
  }
  if (task.provider) {
    parts.push(`<p><strong>Provider:</strong> ${escapeHtml(task.provider)}</p>`);
  }
  if (task.created_by) {
    parts.push(`<p><strong>Created by:</strong> ${escapeHtml(task.created_by)}</p>`);
  }
  if (task.created_at) {
    parts.push(`<p><strong>Created:</strong> ${escapeHtml(formatTimestamp(task.created_at))}</p>`);
  }
  if (task.updated_at && task.updated_at !== task.created_at) {
    parts.push(`<p><strong>Updated:</strong> ${escapeHtml(formatTimestamp(task.updated_at))}</p>`);
  }
  if (task.application) {
    parts.push(`<p><strong>Application:</strong> ${escapeHtml(task.application)}</p>`);
  }
  if (task.status) {
    const label = statusLabels[task.status] || task.status;
    parts.push(
      `<p><strong>Status:</strong> <span class="status status-${escapeHtml(task.status)}">${escapeHtml(label)}</span></p>`
    );
  }
  if (typeof task.queue_position === "number") {
    parts.push(`<p><strong>Queue position:</strong> ${task.queue_position}</p>`);
  }
  if (task.status_raw) {
    parts.push(`<p><strong>Provider status:</strong> ${escapeHtml(task.status_raw)}</p>`);
  }
  if (task.metrics && Object.keys(task.metrics).length > 0) {
    parts.push(`<p><strong>Metrics:</strong> ${escapeHtml(JSON.stringify(task.metrics))}</p>`);
  }
  if (task.result?.seed !== undefined) {
    parts.push(`<p><strong>Seed:</strong> ${escapeHtml(String(task.result.seed))}</p>`);
  }
  if (task.status_url) {
    const url = escapeHtml(task.status_url);
    parts.push(`<p><strong>Status URL:</strong> <a href="${url}" target="_blank" rel="noopener">${url}</a></p>`);
  }
  if (task.result_url) {
    const url = escapeHtml(task.result_url);
    parts.push(`<p><strong>Result URL:</strong> <a href="${url}" target="_blank" rel="noopener">${url}</a></p>`);
  }
  if (task.error?.message) {
    parts.push(`<p class="error-text"><strong>Error:</strong> ${escapeHtml(task.error.message)}</p>`);
  }

  const videoUrl = getVideoUrl(task);
  if (videoUrl) {
    const safeUrl = escapeHtml(videoUrl);
    parts.push(`<p><strong>Video URL:</strong> <a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a></p>`);
  }

  elements.taskInfo.innerHTML = parts.join("\n");
}

function renderHistory() {
  if (!elements.historyList) return;
  if (!sessionManager.isAuthenticated) {
    elements.historyList.innerHTML = '<li class="empty">Sign in to see recent tasks.</li>';
    return;
  }
  if (!state.history.length) {
    elements.historyList.innerHTML = '<li class="empty">No previous tasks yet.</li>';
    return;
  }
  elements.historyList.innerHTML = state.history
    .map((entry) => {
      const id = escapeHtml(entry.id);
      const provider = escapeHtml(entry.provider || "?");
      const status = escapeHtml(entry.status || "unknown");
      const creator = entry.created_by ? ` ? by ${escapeHtml(entry.created_by)}` : "";
      const updated = entry.updated_at ? ` ? ${escapeHtml(formatTimestamp(entry.updated_at))}` : "";
      return `
        <li>
          <div>
            <strong>${id}</strong>
            <br/><small>${provider} ? ${status}${creator}${updated}</small>
          </div>
          <button type="button" data-task-id="${id}" data-provider="${provider}">Open</button>
        </li>`;
    })
    .join("\n");
}

async function refreshHistory() {
  if (!sessionManager.isAuthenticated) {
    state.history = [];
    state.taskCache.clear();
    renderHistory();
    return;
  }
  try {
    const data = await apiClient.json(`${API_BASE}?limit=${HISTORY_LIMIT}`);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.history = tasks.map((task) => ({
      id: task.id,
      provider: task.provider || state.currentProvider,
      application: task.application || "",
      status: task.status || "unknown",
      created_by: task.created_by || null,
      created_at: task.created_at || null,
      updated_at: task.updated_at || null,
      videoUrl: getVideoUrl(task)
    }));
    state.taskCache.clear();
    tasks.forEach((task) => state.taskCache.set(task.id, task));
    renderHistory();
  } catch (error) {
    logMessage(`Unable to refresh history: ${error.message}`, "error");
  }
}

function setAuthMode(mode) {
  state.authMode = mode === AUTH_MODES.register ? AUTH_MODES.register : AUTH_MODES.login;
  elements.authSubmit.textContent = state.authMode === AUTH_MODES.login ? "Sign in" : "Create account";
  elements.authToggle.textContent =
    state.authMode === AUTH_MODES.login ? "Create account" : "Have an account? Sign in";
}

function showAuthError(message) {
  if (!elements.authError) return;
  if (message) {
    elements.authError.textContent = message;
    elements.authError.classList.remove("hidden");
  } else {
    elements.authError.textContent = "";
    elements.authError.classList.add("hidden");
  }
}

function updateAuthUI() {
  const isAuthed = sessionManager.isAuthenticated;
  if (isAuthed) {
    elements.authForm.classList.add("hidden");
    elements.authStatus.classList.remove("hidden");
    elements.authUser.textContent = sessionManager.user?.username || "";
  } else {
    elements.authStatus.classList.add("hidden");
    elements.authForm.classList.remove("hidden");
    elements.authPassword.value = "";
    showAuthError("");
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const username = elements.authUsername.value.trim();
  const password = elements.authPassword.value;
  if (!username || !password) {
    showAuthError("Enter a username and password.");
    return;
  }
  try {
    showAuthError("");
    if (state.authMode === AUTH_MODES.login) {
      await sessionManager.login(username, password);
      logMessage(`Signed in as ${username}.`, "success");
    } else {
      await sessionManager.register(username, password);
      logMessage(`Account created for ${username}.`, "success");
    }
    await refreshAfterAuth();
  } catch (error) {
    showAuthError(error.message);
    logMessage(error.message, "error");
  }
}

async function handleLogout() {
  await sessionManager.logout();
  logMessage("Signed out.", "warn");
  await refreshAfterAuth();
}

async function refreshAfterAuth() {
  await bootstrapServices();
  state.currentProvider = providerStore.getSelected();
  populateProviderOptions();
  updateAuthUI();
  await refreshHistory();
}

function setupAuthHandlers() {
  if (!elements.authForm) {
    return;
  }
  elements.authForm.addEventListener("submit", handleAuthSubmit);
  elements.authToggle.addEventListener("click", () => {
    setAuthMode(state.authMode === AUTH_MODES.login ? AUTH_MODES.register : AUTH_MODES.login);
    showAuthError("");
  });
  if (elements.authLogout) {
    elements.authLogout.addEventListener("click", handleLogout);
  }
  setAuthMode(AUTH_MODES.login);
  updateAuthUI();
}

function populateProviderOptions() {
  const select = elements.provider;
  if (!select) return;
  const providers = providerStore.providers || [];
  const fragment = document.createDocumentFragment();
  providers.forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider;
    option.textContent = provider === "fal" ? "fal.ai proxy" : provider;
    fragment.appendChild(option);
  });
  select.innerHTML = "";
  select.appendChild(fragment);
  const selected = providerStore.getSelected();
  state.currentProvider = selected;
  if (providers.includes(selected)) {
    select.value = selected;
  }
  updateProviderKeyInput();
}

function updateProviderKeyInput() {
  const provider = elements.provider.value;
  state.currentProvider = provider;
  const key = providerStore.getKey(provider);
  elements.providerKey.value = key || "";
}

function setupProviderControls() {
  if (!elements.provider) return;
  elements.provider.addEventListener("change", () => {
    const provider = elements.provider.value;
    providerStore.setSelected(provider);
    updateProviderKeyInput();
  });
  elements.providerKey.addEventListener("input", (event) => {
    providerStore.setKey(elements.provider.value, event.target.value.trim());
  });
  populateProviderOptions();
}

function handleImageSelection(event) {
  const file = event.target.files?.[0];
  if (!file) {
    clearImageUpload(true);
    return;
  }
  if (!file.type.startsWith("image/")) {
    logMessage("Please choose a valid image file.", "error");
    clearImageUpload(true);
    return;
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    logMessage("Image is larger than 15 MB. Choose a smaller file.", "error");
    clearImageUpload(true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.imageDataUrl = reader.result;
    elements.previewImage.src = state.imageDataUrl;
    elements.imagePreview.classList.remove("hidden");
    elements.imageUrl.value = "";
    logMessage(`Loaded image "${file.name}" (${Math.round(file.size / 1024)} KB).`, "info");
  };
  reader.onerror = () => {
    logMessage("Failed to read the selected image file.", "error");
    clearImageUpload(true);
  };
  reader.readAsDataURL(file);
}

function handleImageUrlChange(event) {
  if (event.target.value) {
    clearImageUpload(true);
  }
}

function clearImageUpload(quiet = false) {
  elements.imageInput.value = "";
  state.imageDataUrl = null;
  elements.imagePreview.classList.add("hidden");
  elements.previewImage.removeAttribute("src");
  if (!quiet) {
    logMessage("Removed uploaded image.", "warn");
  }
}

function setupFormHandlers() {
  if (!elements.form) return;
  elements.imageInput.addEventListener("change", handleImageSelection);
  elements.imageUrl.addEventListener("input", handleImageUrlChange);
  elements.clearImage.addEventListener("click", () => clearImageUpload());
  elements.cancelPoll.addEventListener("click", () => {
    stopPolling(false);
    logMessage("Polling cancelled.", "warn");
  });
  elements.historyList.addEventListener("click", handleHistoryClick);
  elements.form.addEventListener("submit", handleSubmit);
}

function requireAuthenticated() {
  if (!sessionManager.isAuthenticated) {
    logMessage("Sign in before submitting tasks.", "error");
    elements.authForm?.classList.remove("hidden");
    return false;
  }
  return true;
}

function buildArguments() {
  const application = elements.application.value.trim();
  const promptText = elements.prompt.value.trim();
  if (!application) {
    throw new Error("Enter an application identifier.");
  }
  if (!promptText) {
    throw new Error("Enter a prompt describing the video.");
  }
  const duration = Number.parseInt(elements.duration.value, 10);
  if (Number.isNaN(duration) || duration < 3 || duration > 12) {
    throw new Error("Duration must be between 3 and 12 seconds.");
  }
  const args = {
    prompt: promptText,
    resolution: elements.resolution.value || "1080p",
    aspect_ratio: elements.aspectRatio.value || "auto",
    duration: String(duration),
    enable_safety_checker: elements.safetyChecker.checked
  };
  if (elements.cameraFixed.checked) {
    args.camera_fixed = true;
  }
  const seedValue = elements.seed.value.trim();
  if (seedValue !== "") {
    const numericSeed = Number.parseInt(seedValue, 10);
    if (Number.isNaN(numericSeed)) {
      throw new Error("Seed must be an integer.");
    }
    args.seed = numericSeed;
  }
  const referenceUrl = state.imageDataUrl || elements.imageUrl.value.trim();
  if (referenceUrl) {
    args.image_url = referenceUrl;
  }
  return { application, arguments: args };
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!requireAuthenticated()) {
    return;
  }
  setBusy(true);
  setVideoUrl(null);
  stopPolling(true);
  try {
    const result = await createTask();
    if (!result) {
      return;
    }
    const intervalSeconds = Math.min(
      30,
      Math.max(2, Number.parseInt(elements.pollInterval.value, 10) || 5)
    );
    pollTask({
      provider: result.provider,
      apiKey: result.apiKey,
      taskId: result.task.id,
      application: result.application,
      intervalSeconds
    });
  } catch (error) {
    logMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function createTask() {
  let payload;
  try {
    const built = buildArguments();
    payload = buildTaskPayload({
      provider: elements.provider.value,
      application: built.application,
      arguments: built.arguments,
      apiKey: elements.providerKey.value.trim()
    });
  } catch (error) {
    logMessage(error.message, "error");
    throw error;
  }

  const provider = payload.provider;
  const apiKey = payload.credentials?.[provider]?.apiKey || "";
  state.currentProvider = provider;
  state.currentApplication = payload.application;
  state.seenLogEntries = new Set();

  logMessage(`Submitting task via ${provider}...`);
  const task = await apiClient
    .json(API_BASE, {
      method: "POST",
      body: payload
    })
    .catch((error) => {
      logMessage(error.message || "Task creation failed.", "error");
      throw error;
    });

  handleTaskResponse(task);
  await refreshHistory();
  return { task, provider, apiKey, application: task.application || payload.application };
}

function handleTaskResponse(task) {
  if (!task) return;
  task.provider = task.provider || state.currentProvider;
  renderTaskInfo(task);
  setVideoUrl(getVideoUrl(task));
  ingestLogs(task.logs);
  cacheTask(task);
}

async function pollTask({ provider, apiKey, taskId, application, intervalSeconds }) {
  stopPolling(true);
  const controller = new AbortController();
  state.pollController = controller;
  elements.cancelPoll.disabled = false;
  elements.cancelPoll.classList.remove("hidden");

  const poll = async () => {
    try {
      logMessage("Checking task status...");
      const search = new URLSearchParams();
      if (application) {
        search.set("application", application);
      }
      if (provider) {
        search.set("provider", provider);
      }
      const response = await apiClient.request(`${API_BASE}/${encodeURIComponent(taskId)}?${search.toString()}`, {
        method: "GET",
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const message = payload?.error?.message || response.statusText || "Status request failed.";
        logMessage(message, "error");
        stopPolling(false);
        return;
      }
      payload.provider = provider;
      handleTaskResponse(payload);

      switch (payload.status) {
        case "queued":
        case "running":
          state.pollTimeoutId = setTimeout(poll, intervalSeconds * 1000);
          break;
        case "succeeded":
          logMessage("Task completed successfully. Video is ready!", "success");
          stopPolling(false);
          await refreshHistory();
          break;
        case "failed":
          logMessage(`Task failed: ${payload.error?.message || "Unknown error."}`, "error");
          stopPolling(false);
          await refreshHistory();
          break;
        case "cancelled":
          logMessage("Task was cancelled.", "warn");
          stopPolling(false);
          await refreshHistory();
          break;
        default:
          logMessage(`Task status: ${payload.status}.`, "warn");
          state.pollTimeoutId = setTimeout(poll, intervalSeconds * 1000);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        logMessage("Polling cancelled.", "warn");
      } else {
        logMessage(`Polling error: ${error.message}`, "error");
      }
      stopPolling(false);
    }
  };

  poll();
}

async function handleHistoryClick(event) {
  const button = event.target.closest("button[data-task-id]");
  if (!button) return;
  const taskId = button.getAttribute("data-task-id");
  const provider = button.getAttribute("data-provider") || state.currentProvider;
  const cached = state.taskCache.get(taskId);
  const application = cached?.application || state.currentApplication || "";
  const params = new URLSearchParams();
  if (application) {
    params.set("application", application);
  }
  if (provider) {
    params.set("provider", provider);
  }
  logMessage(`Loading task ${taskId} (${provider})...`);
  try {
    const task = await apiClient.json(`${API_BASE}/${encodeURIComponent(taskId)}?${params.toString()}`);
    task.provider = provider;
    handleTaskResponse(task);
  } catch (error) {
    logMessage(error.message || "Failed to load task.", "error");
  }
}

async function main() {
  await bootstrapServices();
  setupAuthHandlers();
  setupProviderControls();
  setupFormHandlers();
  updateAuthUI();
  await refreshHistory();
  resetTaskState();
  logMessage('Ready. Configure your request and click "Create task" when you are set.');
}

main().catch((error) => {
  console.error(error);
  logMessage(`Initialisation failed: ${error.message}`, "error");
});
