import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "docs");
const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "8787", 10);
const workspace = path.resolve(process.env.CODEX_WORKSPACE || root);
const networkAccessEnabled = process.env.CODEX_NETWORK_ACCESS === "1";

await assertDirectory(workspace);

const allowedOrigins = new Set([
  "https://yuka-718.github.io",
  `http://${host}:${port}`,
  `http://localhost:${port}`,
  ...String(process.env.CODEX_ALLOWED_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
]);

const bundledDesktopCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
const codexPath =
  process.env.CODEX_BIN || (existsSync(bundledDesktopCodex) ? bundledDesktopCodex : undefined);
const codex = new Codex(codexPath ? { codexPathOverride: codexPath } : {});
let thread = createThread();
let running = false;

function createThread() {
  return codex.startThread({
    workingDirectory: workspace,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled,
    threadSource: "codex_web",
  });
}

function corsHeaders(origin) {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function apiOriginAllowed(req) {
  const origin = req.headers.origin;
  return !origin || allowedOrigins.has(origin);
}

function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;

  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("リクエストが大きすぎます。");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("JSONを読み取れませんでした。");
  }
}

function sendEvent(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}

async function handleRun(req, res, cors) {
  if (running) {
    writeJson(res, 409, { error: "Codexは実行中です。" }, cors);
    return;
  }

  const body = await readJson(req);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    writeJson(res, 400, { error: "プロンプトを入力してください。" }, cors);
    return;
  }
  if (prompt.length > 12_000) {
    writeJson(res, 400, { error: "プロンプトは12,000文字以内にしてください。" }, cors);
    return;
  }

  running = true;
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
    ...cors,
  });

  try {
    const streamed = await thread.runStreamed(prompt, {
      signal: abortController.signal,
    });

    for await (const event of streamed.events) {
      sendEvent(res, event);
    }
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "実行を中断しました。"
        : error instanceof Error
          ? error.message
          : "Codexの実行に失敗しました。";
    if (!res.writableEnded) sendEvent(res, { type: "bridge.error", message });
  } finally {
    running = false;
    if (!res.writableEnded) res.end();
  }
}

async function serveStatic(pathname, res) {
  const fileByPath = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  };
  const entry = fileByPath[pathname];
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const [filename, contentType] = entry;
  const content = await readFile(path.join(publicDir, filename));
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": filename === "index.html" ? "no-cache" : "public, max-age=300",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self' http://127.0.0.1:8787 http://localhost:8787; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  res.end(content);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const cors = corsHeaders(req.headers.origin);

    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      if (!apiOriginAllowed(req)) {
        writeJson(res, 403, { error: "このサイトからは接続できません。" });
        return;
      }
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/") && !apiOriginAllowed(req)) {
      writeJson(res, 403, { error: "このサイトからは接続できません。" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      writeJson(
        res,
        200,
        {
          connected: true,
          running,
          workspace: path.basename(workspace),
          threadId: thread.id,
          networkAccess: networkAccessEnabled,
        },
        cors,
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/new") {
      if (running) {
        writeJson(res, 409, { error: "実行中は新しい会話を開始できません。" }, cors);
        return;
      }
      thread = createThread();
      writeJson(res, 200, { ok: true }, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      await handleRun(req, res, cors);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(url.pathname, res);
      return;
    }

    writeJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "サーバーエラーが発生しました。";
    if (!res.headersSent) writeJson(res, 500, { error: message });
    else if (!res.writableEnded) res.end();
  }
});

server.listen(port, host, () => {
  console.log(`Codex Web: http://${host}:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log("外部公開はしていません。このターミナルを開いたまま使ってください。");
});

async function assertDirectory(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${directory}`);
}
