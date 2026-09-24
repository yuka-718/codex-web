const configuredBridge = String(window.CODEX_BRIDGE_URL || "").replace(/\/$/, "");
let apiBase = location.hostname === "yuka-718.github.io" ? configuredBridge : location.origin;
let accessKey = localStorage.getItem("origami-codex-key") || "";
let attachments = [];
let running = false;
const objectUrls = new Set();

const elements = {
  accessError: document.querySelector("#access-error"),
  accessForm: document.querySelector("#access-form"),
  accessKey: document.querySelector("#access-key"),
  accessScreen: document.querySelector("#access-screen"),
  appShell: document.querySelector("#app-shell"),
  attachmentList: document.querySelector("#attachment-list"),
  endpointField: document.querySelector("#endpoint-field"),
  endpointToggle: document.querySelector("#endpoint-toggle"),
  endpointUrl: document.querySelector("#endpoint-url"),
  fileInput: document.querySelector("#file-input"),
  newProject: document.querySelector("#new-project"),
  prompt: document.querySelector("#prompt"),
  resultSummary: document.querySelector("#result-summary"),
  runButton: document.querySelector("#run-button"),
  runStatus: document.querySelector("#run-status"),
  statusDot: document.querySelector("#status-dot"),
  statusLabel: document.querySelector("#status-label"),
  stepCount: document.querySelector("#step-count"),
  stepsList: document.querySelector("#steps-list"),
};

elements.endpointUrl.value = apiBase;
elements.accessKey.value = accessKey;

function apiHeaders(json = false) {
  return {
    "X-Codex-Key": accessKey,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function setConnected(connected) {
  elements.statusDot.classList.toggle("connected", connected);
  elements.statusDot.classList.toggle("offline", !connected);
  elements.statusLabel.textContent = connected ? "接続済み" : "未接続";
}

async function verifyConnection() {
  if (!apiBase || !accessKey) throw new Error("アクセスキーを入力してください。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${apiBase}/api/status`, {
      headers: apiHeaders(),
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "接続できませんでした。");
    setConnected(true);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function unlockApp() {
  localStorage.setItem("origami-codex-key", accessKey);
  localStorage.setItem("origami-codex-endpoint", apiBase);
  elements.accessScreen.classList.add("hidden");
  elements.appShell.setAttribute("aria-hidden", "false");
  elements.prompt.focus();
}

elements.accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessKey = elements.accessKey.value.trim();
  apiBase = elements.endpointUrl.value.trim().replace(/\/$/, "") || apiBase;
  elements.accessError.textContent = "接続中…";
  try {
    await verifyConnection();
    elements.accessError.textContent = "";
    unlockApp();
  } catch (error) {
    setConnected(false);
    elements.accessError.textContent = error instanceof Error ? error.message : "接続できませんでした。";
  }
});

elements.endpointToggle.addEventListener("click", () => {
  elements.endpointField.classList.toggle("visible");
});

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  for (const [index, file] of attachments.entries()) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const label = document.createElement("span");
    label.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `${file.name}を外す`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      attachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(label, remove);
    elements.attachmentList.append(chip);
  }
  updateRunButton();
}

function addFiles(fileList) {
  const next = [...fileList].filter((file) => file.size <= 12 * 1024 * 1024);
  attachments = [...attachments, ...next].slice(0, 4);
  renderAttachments();
}

elements.fileInput.addEventListener("change", () => {
  addFiles(elements.fileInput.files || []);
  elements.fileInput.value = "";
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.prompt.addEventListener(eventName, (event) => event.preventDefault());
}
elements.prompt.addEventListener("drop", (event) => {
  event.preventDefault();
  addFiles(event.dataTransfer?.files || []);
});

elements.prompt.addEventListener("input", updateRunButton);

function updateRunButton() {
  elements.runButton.disabled = running || (!elements.prompt.value.trim() && attachments.length === 0);
  elements.newProject.disabled = running;
  elements.fileInput.disabled = running;
}

async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${apiBase}/api/upload`, {
    method: "POST",
    headers: apiHeaders(),
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${file.name}を送信できませんでした。`);
  return body;
}

async function parseNdjson(response, onEvent) {
  if (!response.body) throw new Error("レスポンスを読み取れませんでした。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

function describeEvent(event) {
  const item = event.item;
  if (!item) return null;
  if (item.type === "reasoning") return item.text || "設計を検討中";
  if (item.type === "command_execution") return item.status === "completed" ? "計算を確認中" : "計算中";
  if (item.type === "file_change") return "成果物を作成中";
  if (item.type === "mcp_tool_call") return "Orieditaで検証中";
  if (item.type === "web_search") return "資料を確認中";
  return null;
}

elements.runButton.addEventListener("click", async () => {
  if (running) return;
  running = true;
  updateRunButton();
  resetResults();
  elements.runStatus.textContent = attachments.length ? "ファイルを送信中" : "設計を開始中";

  try {
    const uploaded = [];
    for (const file of attachments) uploaded.push(await uploadFile(file));
    elements.runStatus.textContent = "Codexが設計中";
    const response = await fetch(`${apiBase}/api/run`, {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify({
        prompt: elements.prompt.value.trim(),
        attachments: uploaded.map((file) => file.id),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }

    let result = null;
    let failure = null;
    await parseNdjson(response, (event) => {
      const description = describeEvent(event);
      if (description) elements.runStatus.textContent = description;
      if (event.type === "bridge.result") result = event.result;
      if (event.type === "bridge.error" || event.type === "turn.failed") {
        failure = event.message || event.error?.message || "設計に失敗しました。";
      }
    });
    if (failure) throw new Error(failure);
    if (!result) throw new Error("結果を受け取れませんでした。");
    await renderResult(result);
    elements.runStatus.textContent = "完了";
    attachments = [];
    renderAttachments();
  } catch (error) {
    elements.runStatus.textContent = error instanceof Error ? error.message : "設計に失敗しました。";
  } finally {
    running = false;
    updateRunButton();
  }
});

async function renderResult(result) {
  elements.resultSummary.textContent = result.summary || "";
  await Promise.all(["prediction", "oriedita", "model"].map((key) => renderPanel(key, result[key])));
  await renderSteps(result.steps || []);
}

async function renderPanel(key, panel) {
  const stage = document.querySelector(`[data-stage="${key}"]`);
  const caption = document.querySelector(`[data-caption="${key}"]`);
  const link = document.querySelector(`[data-link="${key}"]`);
  caption.textContent = panel?.caption || "";
  link.hidden = true;
  link.removeAttribute("href");

  if (panel?.previewPath) {
    try {
      const url = await artifactObjectUrl(panel.previewPath);
      const image = document.createElement("img");
      image.src = url;
      image.alt = panel.caption || `${key}のプレビュー`;
      stage.replaceChildren(image);
    } catch {
      stage.replaceChildren(createEmptyText("プレビューを開けませんでした"));
    }
  }
  if (panel?.filePath) {
    try {
      link.href = await artifactObjectUrl(panel.filePath);
      link.download = panel.filePath.split("/").pop() || "artifact";
      link.hidden = false;
    } catch {
      link.hidden = true;
    }
  }
}

async function renderSteps(steps) {
  elements.stepsList.replaceChildren();
  elements.stepCount.textContent = `${steps.length} steps`;
  if (steps.length === 0) {
    const empty = document.createElement("li");
    empty.className = "steps-empty";
    empty.textContent = "折順はまだありません";
    elements.stepsList.append(empty);
    return;
  }
  for (const step of steps) {
    const item = document.createElement("li");
    item.className = "step-card";
    const number = document.createElement("div");
    number.className = "step-number";
    number.textContent = step.number;
    const title = document.createElement("h3");
    title.textContent = step.title;
    const instruction = document.createElement("p");
    instruction.textContent = step.instruction;
    item.append(number, title, instruction);
    if (step.imagePath) {
      try {
        const image = document.createElement("img");
        image.src = await artifactObjectUrl(step.imagePath);
        image.alt = `手順${step.number}: ${step.title}`;
        item.append(image);
      } catch {}
    }
    elements.stepsList.append(item);
  }
}

async function artifactObjectUrl(relativePath) {
  const response = await fetch(`${apiBase}/api/artifact?path=${encodeURIComponent(relativePath)}`, {
    headers: apiHeaders(),
  });
  if (!response.ok) throw new Error("成果物を開けませんでした。");
  const url = URL.createObjectURL(await response.blob());
  objectUrls.add(url);
  return url;
}

function createEmptyText(text) {
  const label = document.createElement("span");
  label.textContent = text;
  return label;
}

function resetResults() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  elements.resultSummary.textContent = "";
  const defaults = {
    prediction: "まだありません",
    oriedita: "検証結果を表示",
    model: "微調整後の形を表示",
  };
  for (const key of Object.keys(defaults)) {
    const stage = document.querySelector(`[data-stage="${key}"]`);
    stage.replaceChildren(createEmptyText(running ? "作成中…" : defaults[key]));
    document.querySelector(`[data-caption="${key}"]`).textContent = "";
    document.querySelector(`[data-link="${key}"]`).hidden = true;
  }
  elements.stepsList.replaceChildren(createEmptyStep());
  elements.stepCount.textContent = "0 steps";
}

function createEmptyStep() {
  const item = document.createElement("li");
  item.className = "steps-empty";
  item.textContent = running ? "折順を作成中…" : "折順はここに表示されます";
  return item;
}

elements.newProject.addEventListener("click", async () => {
  if (running) return;
  try {
    const response = await fetch(`${apiBase}/api/new`, {
      method: "POST",
      headers: apiHeaders(true),
      body: "{}",
    });
    if (!response.ok) throw new Error();
    elements.prompt.value = "";
    attachments = [];
    renderAttachments();
    resetResults();
    elements.runStatus.textContent = "";
    elements.prompt.focus();
  } catch {
    setConnected(false);
  }
});

function registerWebMcpTool() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  void Promise.resolve(
    context.registerTool(
      {
        name: "start_origami_design",
        title: "折り紙設計を開始",
        description: "入力した要望をプロンプト欄へ入れ、折り紙設計を開始します。",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string", minLength: 1, maxLength: 12000 } },
          required: ["prompt"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input) {
          if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) {
            throw new Error("promptは空にできません。");
          }
          elements.prompt.value = input.prompt;
          updateRunButton();
          elements.runButton.click();
          return { started: true };
        },
      },
      { signal: lifecycle.signal },
    ),
  ).catch(() => {});
}

const savedEndpoint = localStorage.getItem("origami-codex-endpoint");
if (location.hostname === "yuka-718.github.io" && savedEndpoint) {
  apiBase = savedEndpoint.replace(/\/$/, "");
  elements.endpointUrl.value = apiBase;
}

registerWebMcpTool();
updateRunButton();
if (accessKey && apiBase) {
  verifyConnection().then(unlockApp).catch(() => {
    localStorage.removeItem("origami-codex-key");
    setConnected(false);
  });
}
