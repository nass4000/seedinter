import { apiClient, bootstrapServices, buildTaskPayload, providerStore } from "./client.js";

const API_BASE = "/api/tasks";
const HISTORY_LIMIT = 15;
const MAX_LOG_ENTRIES = 200;
const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 10;

const statusLabels = {
  queued: "Queued",
  running: "Running",
  cancelled: "Cancelled",
  succeeded: "Succeeded",
  failed: "Failed"
};

const elements = {
  form: document.getElementById("edit-form"),
  provider: document.getElementById("provider"),
  providerKey: document.getElementById("provider-key"),
  application: document.getElementById("application"),
  prompt: document.getElementById("prompt"),
  imageSize: document.getElementById("image-size"),
  customSizeFields: document.getElementById("custom-size-fields"),
  customWidth: document.getElementById("custom-width"),
  customHeight: document.getElementById("custom-height"),
  numImages: document.getElementById("num-images"),
  maxImages: document.getElementById("max-images"),
  safetyChecker: document.getElementById("safety-checker"),
  syncMode: document.getElementById("sync-mode"),
  seed: document.getElementById("seed"),
  imageInput: document.getElementById("image-input"),
  imageUrls: document.getElementById("image-urls"),
  uploadPreview: document.getElementById("upload-preview"),
  pollInterval: document.getElementById("poll-interval"),
  submitButton: document.getElementById("submit-button"),
  cancelPoll: document.getElementById("cancel-poll"),
  taskInfo: document.getElementById("task-info"),
  log: document.getElementById("log"),
  gallery: document.getElementById("result-gallery"),
  statusPlaceholder: document.getElementById("status-placeholder"),
  taskBadge: document.getElementById("task-badge"),
  historyList: document.getElementById("history-list"),
  imageAttachBtn: document.getElementById("image-attach-btn"),
  promptBtn: document.getElementById("prompt-btn"),
  promptModal: document.getElementById("prompt-modal"),
  promptModalClose: document.getElementById("prompt-modal-close"),
  promptApply: document.getElementById("prompt-apply"),
  imageModal: document.getElementById("image-modal"),
  imageModalClose: document.getElementById("image-modal-close"),
  imageApply: document.getElementById("image-apply")
};

const state = {
  uploads: [],
  logEntries: [],
  seenLogEntries: new Set(),
  pollController: null,
  pollTimeoutId: null,
  currentApplication: null,
  currentProvider: "fal",
  history: [],
  taskCache: new Map()
};

function logMessage(message, level = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const prefix =
    level === "error" ? "ERR" : level === "success" ? "OK " : level === "warn" ? "WRN" : "INF";
  const entry = `[${timestamp}] ${prefix} ${message}`;
  state.logEntries.push(entry);
  if (state.logEntries.length > MAX_LOG_ENTRIES) state.logEntries.shift();
  elements.log.textContent = state.logEntries.join("\n");
  elements.log.scrollTop = elements.log.scrollHeight;
}

function escapeHtml(value) {
  return value
    ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;").replace(/'/g, "&#039;")
    : "";
}

function formatTimestamp(value) {
  if (!value) return "";
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function collectImageResults(task) {
  const urls = new Set();
  const contentImages = task?.content?.image_urls;
  if (Array.isArray(contentImages)) contentImages.forEach((u) => { if (u) urls.add(u); });
  const resultImages = task?.result?.images;
  if (Array.isArray(resultImages)) resultImages.forEach((item) => { if (item?.url) urls.add(item.url); });
  return Array.from(urls);
}

function updateStatusBadge(task) {
  const badge = elements.taskBadge;
  if (!badge) return;
  if (!task?.status) { badge.className = "status-badge hidden"; badge.textContent = ""; return; }
  const label = statusLabels[task.status] || task.status;
  badge.textContent = label;
  badge.className = `status-badge status-badge-${task.status}`;
}

function renderGallery(task) {
  const ph = elements.statusPlaceholder;
  if (!task) {
    elements.gallery.classList.add("hidden"); elements.gallery.innerHTML = "";
    if (ph) ph.classList.remove("hidden");
    return;
  }
  const images = collectImageResults(task);
  if (!images.length) {
    elements.gallery.classList.add("hidden"); elements.gallery.innerHTML = "";
    if (ph) ph.classList.remove("hidden");
    return;
  }
  elements.gallery.innerHTML = images
    .map((url, i) => `<img src="${escapeHtml(url)}" alt="Result ${i + 1}" />`)
    .join("\n");
  elements.gallery.classList.remove("hidden");
  if (ph) ph.classList.add("hidden");
}

function setBusy(isBusy) {
  elements.submitButton.disabled = isBusy;
  elements.form.classList.toggle("is-busy", isBusy);
  elements.form.setAttribute("aria-busy", isBusy ? "true" : "false");
}

function resetTaskState() {
  elements.taskInfo.textContent = "";
  if (elements.taskBadge) { elements.taskBadge.className = "status-badge hidden"; elements.taskBadge.textContent = ""; }
  if (elements.statusPlaceholder) elements.statusPlaceholder.classList.remove("hidden");
  renderGallery(null);
  state.logEntries = [];
  elements.log.textContent = "";
  state.seenLogEntries = new Set();
}

function stopPolling(clearStatus = false) {
  if (state.pollTimeoutId) { clearTimeout(state.pollTimeoutId); state.pollTimeoutId = null; }
  if (state.pollController) { state.pollController.abort(); state.pollController = null; }
  elements.cancelPoll.disabled = true;
  if (clearStatus) elements.cancelPoll.classList.add("hidden");
}

function ingestLogs(logs) {
  if (!Array.isArray(logs)) return;
  logs.forEach((entry) => {
    if (!entry) return;
    const message = typeof entry.message === "string" ? entry.message : JSON.stringify(entry);
    const key = `${entry.id ?? ""}-${message}`;
    if (state.seenLogEntries.has(key)) return;
    state.seenLogEntries.add(key);
    const level = (typeof entry.level === "string" ? entry.level : "").toLowerCase();
    const logLevel = level.includes("error") ? "error" : level.includes("warn") ? "warn" : level.includes("success") ? "success" : "info";
    logMessage(message, logLevel);
  });
}

function cacheTask(task) {
  if (!task?.id) return;
  state.taskCache.set(task.id, task);
  const entry = {
    id: task.id,
    provider: task.provider || state.currentProvider,
    application: task.application || state.currentApplication || "",
    status: task.status || "unknown",
    created_at: task.created_at || null,
    updated_at: task.updated_at || new Date().toISOString(),
    hasImages: collectImageResults(task).length > 0
  };
  const index = state.history.findIndex((item) => item.id === task.id);
  if (index >= 0) { state.history[index] = { ...state.history[index], ...entry }; }
  else { state.history.unshift(entry); if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT; }
  renderHistory();
}

function renderTaskInfo(task) {
  updateStatusBadge(task);
  if (!task) { elements.taskInfo.textContent = ""; return; }
  const parts = [];
  if (task.id) parts.push(`ID: ${escapeHtml(task.id)}`);
  if (task.status) parts.push(`Status: ${statusLabels[task.status] || task.status}`);
  if (typeof task.queue_position === "number") parts.push(`Queue: ${task.queue_position}`);
  if (task.error?.message) parts.push(`Error: ${escapeHtml(task.error.message)}`);
  elements.taskInfo.textContent = parts.join(" · ");
}

function renderHistory() {
  if (!elements.historyList) return;
  if (!state.history.length) {
    elements.historyList.innerHTML = '<li class="empty">No previous tasks yet.</li>';
    return;
  }
  elements.historyList.innerHTML = state.history
    .map((entry) => {
      const id = escapeHtml(entry.id);
      const provider = escapeHtml(entry.provider || "?");
      const status = escapeHtml(entry.status || "unknown");
      const updated = entry.updated_at ? ` · ${escapeHtml(formatTimestamp(entry.updated_at))}` : "";
      const badge = entry.hasImages ? "· images" : "";
      return `<li>
        <div><strong>${id}</strong><br/><small>${provider} · ${status}${badge}${updated}</small></div>
        <button type="button" data-task-id="${id}" data-provider="${provider}">Open</button>
      </li>`;
    })
    .join("\n");
}

async function refreshHistory() {
  try {
    const data = await apiClient.json(`${API_BASE}?limit=${HISTORY_LIMIT}`);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.history = tasks.map((task) => ({
      id: task.id,
      provider: task.provider || state.currentProvider,
      application: task.application || "",
      status: task.status || "unknown",
      created_at: task.created_at || null,
      updated_at: task.updated_at || null,
      hasImages: collectImageResults(task).length > 0
    }));
    state.taskCache.clear();
    tasks.forEach((task) => state.taskCache.set(task.id, task));
    renderHistory();
  } catch (error) {
    logMessage(`Unable to refresh history: ${error.message}`, "error");
  }
}

function populateProviderOptions() {
  if (!elements.provider) return;
  elements.provider.innerHTML = '<option value="fal">fal.ai</option>';
  elements.provider.value = "fal";
  state.currentProvider = "fal";
  providerStore.setSelected("fal");
  const key = providerStore.getKey("fal");
  elements.providerKey.value = key || "";
}

function setupProviderControls() {
  if (!elements.provider) return;
  elements.providerKey.addEventListener("input", (event) => {
    providerStore.setKey("fal", event.target.value.trim());
  });
  populateProviderOptions();
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) { reject(new Error("File is not an image.")); return; }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) { reject(new Error(`File ${file.name} is larger than 20 MB.`)); return; }
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, size: file.size, url: reader.result });
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function renderUploadPreview() {
  if (!state.uploads.length) { elements.uploadPreview.classList.add("hidden"); elements.uploadPreview.innerHTML = ""; return; }
  elements.uploadPreview.innerHTML = state.uploads
    .map((item, index) => {
      const sizeKb = Math.max(1, Math.round(item.size / 1024));
      return `<figure class="thumb">
        <img src="${item.url}" alt="Upload ${escapeHtml(item.name)}" />
        <figcaption>${escapeHtml(item.name)} (${sizeKb} KB)</figcaption>
        <button type="button" class="tiny" data-remove="${index}">Remove</button>
      </figure>`;
    })
    .join("\n");
  elements.uploadPreview.classList.remove("hidden");
}

function collectReferenceImages() {
  const urls = [];
  state.uploads.forEach((item) => { if (item.url) urls.push(item.url); });
  elements.imageUrls.value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).forEach((u) => urls.push(u));
  if (urls.length > MAX_REFERENCE_IMAGES) {
    logMessage(`Too many reference images; trimming to ${MAX_REFERENCE_IMAGES}.`, "warn");
    return urls.slice(0, MAX_REFERENCE_IMAGES);
  }
  return urls;
}

function openModal(modal) {
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeModal(modal) {
  modal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function setupModals() {
  elements.promptBtn.addEventListener("click", () => openModal(elements.promptModal));
  elements.promptModalClose.addEventListener("click", () => closeModal(elements.promptModal));
  elements.promptApply.addEventListener("click", () => closeModal(elements.promptModal));

  elements.imageAttachBtn.addEventListener("click", () => openModal(elements.imageModal));
  elements.imageModalClose.addEventListener("click", () => closeModal(elements.imageModal));
  elements.imageApply.addEventListener("click", () => closeModal(elements.imageModal));

  [elements.promptModal, elements.imageModal].forEach((modal) => {
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(modal); });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      [elements.promptModal, elements.imageModal].forEach((modal) => {
        if (!modal.classList.contains("hidden")) closeModal(modal);
      });
    }
  });
}

function setupFormHandlers() {
  if (!elements.form) return;
  elements.form.addEventListener("submit", handleSubmit);
  elements.historyList.addEventListener("click", handleHistoryClick);
  elements.cancelPoll.addEventListener("click", () => { stopPolling(false); logMessage("Polling cancelled.", "warn"); });
  elements.imageSize.addEventListener("change", () => {
    const useCustom = elements.imageSize.value === "custom";
    elements.customSizeFields.classList.toggle("hidden", !useCustom);
    if (!useCustom) { elements.customWidth.value = ""; elements.customHeight.value = ""; }
  });
  elements.imageInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const remainingSlots = MAX_REFERENCE_IMAGES - state.uploads.length;
    if (remainingSlots <= 0) { logMessage("Maximum number of uploaded images reached.", "warn"); elements.imageInput.value = ""; return; }
    const usableFiles = files.slice(0, remainingSlots);
    try {
      const results = await Promise.all(usableFiles.map(readImageFile));
      state.uploads.push(...results);
      logMessage(`Loaded ${results.length} image(s) from upload.`, "info");
      renderUploadPreview();
    } catch (error) {
      logMessage(`Failed to read image: ${error.message}`, "error");
    } finally {
      elements.imageInput.value = "";
    }
  });
  elements.uploadPreview.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLButtonElement && target.dataset.remove) {
      const index = Number.parseInt(target.dataset.remove, 10);
      if (!Number.isNaN(index)) { state.uploads.splice(index, 1); renderUploadPreview(); }
    }
  });
}

function buildArguments() {
  const application = elements.application.value.trim();
  const promptText = elements.prompt.value.trim();
  if (!application) throw new Error("Enter an application identifier.");
  if (!promptText) throw new Error("Enter an edit prompt.");
  const references = collectReferenceImages();
  const isEdit = application.includes("/edit");
  if (isEdit && !references.length) throw new Error("Provide at least one reference image (upload or URL) for edit models.");
  const numImages = Number.parseInt(elements.numImages.value, 10);
  if (Number.isNaN(numImages) || numImages < 1) throw new Error("Generations must be at least 1.");
  const maxImages = Number.parseInt(elements.maxImages.value, 10);
  if (Number.isNaN(maxImages) || maxImages < 1) throw new Error("Max images must be at least 1.");
  const args = {
    prompt: promptText,
    num_images: numImages,
    max_images: maxImages,
    enable_safety_checker: elements.safetyChecker.checked
  };
  if (references.length) args.image_urls = references;
  if (elements.imageSize.value === "custom") {
    const width = Number.parseInt(elements.customWidth.value, 10);
    const height = Number.parseInt(elements.customHeight.value, 10);
    if ([width, height].some((v) => Number.isNaN(v))) throw new Error("Provide both width and height for custom size.");
    if (width < 1024 || height < 1024 || width > 4096 || height > 4096) throw new Error("Custom dimensions must be 1024–4096 px.");
    args.image_size = { width, height };
  } else {
    args.image_size = elements.imageSize.value;
  }
  if (elements.syncMode.checked) args.sync_mode = true;
  const seedToken = elements.seed.value.trim();
  if (seedToken !== "") {
    const seedValue = Number.parseInt(seedToken, 10);
    if (Number.isNaN(seedValue)) throw new Error("Seed must be an integer.");
    args.seed = seedValue;
  }
  return { application, arguments: args };
}

async function handleSubmit(event) {
  event.preventDefault();
  setBusy(true);
  renderGallery(null);
  stopPolling(true);
  try {
    const result = await createTask();
    if (!result) return;
    const intervalSeconds = Math.min(30, Math.max(2, Number.parseInt(elements.pollInterval.value, 10) || 5));
    pollTask({ provider: result.provider, apiKey: result.apiKey, taskId: result.task.id, application: result.application, intervalSeconds });
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
  logMessage(`Submitting edit task via ${provider}…`);
  const task = await apiClient.json(API_BASE, { method: "POST", body: payload }).catch((error) => {
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
  renderGallery(task);
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
      logMessage("Checking task status…");
      const search = new URLSearchParams();
      if (application) search.set("application", application);
      if (provider) search.set("provider", provider);
      const response = await apiClient.request(`${API_BASE}/${encodeURIComponent(taskId)}?${search.toString()}`, { method: "GET", signal: controller.signal });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) { logMessage(payload?.error?.message || response.statusText || "Status request failed.", "error"); stopPolling(false); return; }
      payload.provider = provider;
      handleTaskResponse(payload);
      switch (payload.status) {
        case "queued":
        case "running":
          state.pollTimeoutId = setTimeout(poll, intervalSeconds * 1000);
          break;
        case "succeeded":
          logMessage("Task completed. Images are ready!", "success");
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
      if (error.name === "AbortError") logMessage("Polling cancelled.", "warn");
      else logMessage(`Polling error: ${error.message}`, "error");
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
  if (application) params.set("application", application);
  if (provider) params.set("provider", provider);
  logMessage(`Loading task ${taskId} (${provider})…`);
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
  setupProviderControls();
  setupFormHandlers();
  setupModals();
  renderUploadPreview();
  await refreshHistory();
  resetTaskState();
  logMessage('Ready. Click Prompt to write your edit, Image to attach photos, then "Start edit".');
}

main().catch((error) => {
  console.error(error);
  logMessage(`Initialisation failed: ${error.message}`, "error");
});
