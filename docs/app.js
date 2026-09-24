const bridgeOrigin = "http://127.0.0.1:8787";
const apiBase = ["127.0.0.1", "localhost"].includes(location.hostname)
  ? location.origin
  : bridgeOrigin;

const elements = {
  composer: document.querySelector("#composer"),
  conversation: document.querySelector("#conversation"),
  empty: document.querySelector("#empty-state"),
  hint: document.querySelector("#hint"),
  localLink: document.querySelector("#local-link"),
  newThread: document.querySelector("#new-thread"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send-button"),
  statusDot: document.querySelector("#status-dot"),
  statusLabel: document.querySelector("#status-label"),
  workspace: document.querySelector("#workspace-name"),
};

let connected = false;
let running = false;

function setConnection(isConnected, status = {}) {
  connected = isConnected;
  elements.statusDot.classList.toggle("connected", isConnected);
  elements.statusDot.classList.toggle("offline", !isConnected);
  elements.statusLabel.textContent = isConnected ? "Macに接続済み" : "Macと未接続";
  elements.workspace.textContent = status.workspace ? `· ${status.workspace}` : "";
  elements.localLink.classList.toggle("visible", !isConnected && location.protocol === "https:");
  elements.prompt.disabled = !isConnected || running;
  elements.send.disabled = !isConnected || running || !elements.prompt.value.trim();
  elements.newThread.disabled = !isConnected || running;
  elements.hint.textContent = isConnected
    ? "このMacのCodexに接続しています"
    : "Mac側で npm start を実行してください";
}

async function checkConnection() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2200);
  try {
    const response = await fetch(`${apiBase}/api/status`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("offline");
    setConnection(true, await response.json());
  } catch {
    setConnection(false);
  } finally {
    clearTimeout(timeout);
  }
}

function resizePrompt() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
}

function scrollToLatest() {
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function addMessage(kind, text = "") {
  elements.empty?.remove();
  elements.empty = null;
  const message = document.createElement("article");
  message.className = `message ${kind}`;
  message.textContent = text;
  elements.conversation.append(message);
  scrollToLatest();
  return message;
}

function createRunStatus() {
  const message = addMessage("assistant");
  const status = document.createElement("div");
  status.className = "run-status";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "考えています";
  status.append(spinner, label);
  message.append(status);
  return { message, status, label };
}

function describeEvent(event) {
  const item = event.item;
  if (!item) return null;
  if (item.type === "reasoning") return item.text || "考えています";
  if (item.type === "command_execution") {
    if (item.status === "completed") return "コマンドを実行しました";
    if (item.status === "failed") return "コマンドの実行に失敗しました";
    return "コマンドを実行中";
  }
  if (item.type === "file_change") {
    const count = item.changes?.length || 0;
    return `${count}件のファイルを更新しました`;
  }
  if (item.type === "web_search") return "ウェブを確認しています";
  if (item.type === "mcp_tool_call") return "ツールを実行しています";
  if (item.type === "todo_list") return "作業を進めています";
  if (item.type === "error") return item.message;
  return null;
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
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

async function sendPrompt(prompt) {
  if (!connected || running || !prompt.trim()) return null;
  running = true;
  setConnection(true, { workspace: elements.workspace.textContent.replace(/^·\s*/, "") });

  addMessage("user", prompt.trim());
  const runView = createRunStatus();
  let finalResponse = "";
  let failed = false;

  try {
    const response = await fetch(`${apiBase}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }

    await parseNdjson(response, (event) => {
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalResponse = event.item.text;
      }
      if (event.type === "turn.failed" || event.type === "bridge.error") {
        failed = true;
        finalResponse = event.error?.message || event.message || "実行に失敗しました。";
      }
      const description = describeEvent(event);
      if (description) runView.label.textContent = description;
      scrollToLatest();
    });

    runView.status.remove();
    runView.message.textContent = finalResponse || (failed ? "実行に失敗しました。" : "完了しました。");
    runView.message.classList.toggle("error", failed);
    scrollToLatest();
    return { response: finalResponse, failed };
  } catch (error) {
    failed = true;
    runView.status.remove();
    runView.message.textContent =
      error instanceof Error ? error.message : "Codexとの接続に失敗しました。";
    runView.message.classList.add("error");
    setConnection(false);
    scrollToLatest();
    return { response: runView.message.textContent, failed };
  } finally {
    running = false;
    setConnection(connected, { workspace: elements.workspace.textContent.replace(/^·\s*/, "") });
    elements.prompt.focus();
  }
}

elements.prompt.addEventListener("input", () => {
  resizePrompt();
  elements.send.disabled = !connected || running || !elements.prompt.value.trim();
});

elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = elements.prompt.value;
  if (!prompt.trim()) return;
  elements.prompt.value = "";
  resizePrompt();
  await sendPrompt(prompt);
});

elements.newThread.addEventListener("click", async () => {
  if (!connected || running) return;
  try {
    const response = await fetch(`${apiBase}/api/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error();
    elements.conversation.replaceChildren();
    const empty = document.createElement("section");
    empty.className = "empty-state";
    empty.id = "empty-state";
    const title = document.createElement("h1");
    title.textContent = "何をしますか？";
    empty.append(title);
    elements.conversation.append(empty);
    elements.empty = empty;
    elements.prompt.focus();
  } catch {
    setConnection(false);
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
        name: "send_prompt_to_codex",
        title: "Codexへ送信",
        description: "入力したプロンプトを、このMacで動いているCodexへ送り、結果を画面に表示します。",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 12000 },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input) {
          if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) {
            throw new Error("promptは空にできません。");
          }
          const result = await sendPrompt(input.prompt);
          if (!result) throw new Error("Codexへ送信できませんでした。");
          if (result.failed) throw new Error(result.response);
          return { response: result.response };
        },
      },
      { signal: lifecycle.signal },
    ),
  ).catch(() => {});
}

registerWebMcpTool();
void checkConnection();
setInterval(checkConnection, 15_000);
