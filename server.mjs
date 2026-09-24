import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "docs");
const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "8787", 10);
const workspace = path.resolve(process.env.CODEX_WORKSPACE || path.dirname(root));
const workspaceReal = await realpath(workspace);
const uploadDir = path.join(workspace, ".codex-web", "uploads");
const networkAccessEnabled = process.env.CODEX_NETWORK_ACCESS === "1";
const accessKey = process.env.CODEX_ACCESS_KEY || (await loadOrCreateAccessKey());
const maxUploadBytes = 12 * 1024 * 1024;

await assertDirectory(workspace);
await mkdir(uploadDir, { recursive: true });

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
const uploads = new Map();
let thread = createThread();
let running = false;

const resultSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    prediction: {
      type: "object",
      properties: {
        previewPath: { type: ["string", "null"] },
        filePath: { type: ["string", "null"] },
        caption: { type: "string" },
      },
      required: ["previewPath", "filePath", "caption"],
      additionalProperties: false,
    },
    oriedita: {
      type: "object",
      properties: {
        previewPath: { type: ["string", "null"] },
        filePath: { type: ["string", "null"] },
        caption: { type: "string" },
      },
      required: ["previewPath", "filePath", "caption"],
      additionalProperties: false,
    },
    model: {
      type: "object",
      properties: {
        previewPath: { type: ["string", "null"] },
        filePath: { type: ["string", "null"] },
        caption: { type: "string" },
      },
      required: ["previewPath", "filePath", "caption"],
      additionalProperties: false,
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          title: { type: "string" },
          instruction: { type: "string" },
          imagePath: { type: ["string", "null"] },
        },
        required: ["number", "title", "instruction", "imagePath"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "prediction", "oriedita", "model", "steps"],
  additionalProperties: false,
};

function createThread() {
  return codex.startThread({
    workingDirectory: workspace,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled,
    threadSource: "origami_web",
  });
}

function corsHeaders(origin) {
  if (!origin || allowedOrigins.has(origin) || origin.endsWith(".trycloudflare.com")) {
    return origin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Codex-Key",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        }
      : {};
  }
  return {};
}

function apiOriginAllowed(req) {
  const origin = req.headers.origin;
  return (
    !origin ||
    allowedOrigins.has(origin) ||
    origin === `https://${req.headers.host}` ||
    origin.endsWith(".trycloudflare.com")
  );
}

function authorized(req) {
  const supplied = String(req.headers["x-codex-key"] || "");
  const expectedBuffer = Buffer.from(accessKey);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 96 * 1024) throw new Error("リクエストが大きすぎます。");
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

async function handleUpload(req, res, cors) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (!contentLength || contentLength > maxUploadBytes + 1024 * 1024) {
    writeJson(res, 413, { error: "ファイルは12MB以内にしてください。" }, cors);
    return;
  }

  const request = new Request(`http://${host}:${port}/api/upload`, {
    method: "POST",
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > maxUploadBytes) {
    writeJson(res, 400, { error: "有効なファイルを選んでください。" }, cors);
    return;
  }

  const originalName = path.basename(file.name || "attachment");
  const extension = path.extname(originalName).toLowerCase();
  const allowedExtensions = new Set([
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".pdf", ".txt", ".md",
    ".json", ".cp", ".fold", ".ori", ".obj", ".glb", ".gltf",
  ]);
  if (!allowedExtensions.has(extension)) {
    writeJson(res, 400, { error: "このファイル形式には対応していません。" }, cors);
    return;
  }

  const id = randomUUID();
  const filePath = path.join(uploadDir, `${id}${extension}`);
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()), { flag: "wx", mode: 0o600 });
  uploads.set(id, {
    id,
    path: filePath,
    name: originalName,
    type: file.type || mimeFromExtension(extension),
    size: file.size,
    createdAt: Date.now(),
  });
  writeJson(res, 200, { id, name: originalName, type: file.type, size: file.size }, cors);
}

async function handleRun(req, res, cors) {
  if (running) {
    writeJson(res, 409, { error: "Codexは実行中です。" }, cors);
    return;
  }

  const body = await readJson(req);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const attachmentIds = Array.isArray(body.attachments) ? body.attachments.slice(0, 4) : [];
  if (!prompt && attachmentIds.length === 0) {
    writeJson(res, 400, { error: "プロンプトかファイルを入力してください。" }, cors);
    return;
  }
  if (prompt.length > 12_000) {
    writeJson(res, 400, { error: "プロンプトは12,000文字以内にしてください。" }, cors);
    return;
  }

  const selectedUploads = attachmentIds.map((id) => uploads.get(String(id))).filter(Boolean);
  if (selectedUploads.length !== attachmentIds.length) {
    writeJson(res, 400, { error: "添付ファイルを再度選択してください。" }, cors);
    return;
  }

  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-") + `-${randomUUID().slice(0, 8)}`;
  const runOutput = path.join(workspace, "output", "web-runs", runId);
  await mkdir(runOutput, { recursive: true });

  const nonImageNotes = selectedUploads
    .filter((file) => !file.type.startsWith("image/"))
    .map((file) => `- ${file.name}: ${file.path}`)
    .join("\n");
  const instruction = `あなたは折り紙設計専用のCodexです。利用者の依頼を実際に作業してください。

最初に tools/ORIGAMI_TOOLS.md を読み、既存の折り紙設計・Oriedita・検証ツールを優先して使ってください。
成果物は ${runOutput} 以下に保存してください。

必要な出力:
1. 完成予想図: PNG/JPG/SVGのプレビューと元成果物。
2. Oriedita結果: 検証済みプレビューと .ori/.cp/.fold のいずれか。
3. 微調整後の立体モデル: 立体感が確認できるプレビューと、可能なら .obj/.glb/.gltf または折り状態データ。
4. 折順: 短く明確な手順。図が作れた場合は各ステップ画像も保存する。

存在しないファイルパスは絶対に返さず、作れなかった項目は null にしてください。返すパスは作業フォルダからの相対パスにしてください。

利用者の依頼:
${prompt || "添付資料をもとに折り紙を設計してください。"}
${nonImageNotes ? `\n添付ファイル:\n${nonImageNotes}` : ""}`;

  const sdkInput = [{ type: "text", text: instruction }];
  for (const file of selectedUploads) {
    if (file.type.startsWith("image/")) sdkInput.push({ type: "local_image", path: file.path });
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

  let finalText = "";
  try {
    const streamed = await thread.runStreamed(sdkInput, {
      signal: abortController.signal,
      outputSchema: resultSchema,
    });
    for await (const event of streamed.events) {
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalText = event.item.text;
      } else {
        sendEvent(res, event);
      }
    }
    let result;
    try {
      result = JSON.parse(finalText);
    } catch {
      result = emptyResult(finalText || "処理は完了しましたが、結果を整理できませんでした。");
    }
    sendEvent(res, { type: "bridge.result", result: await normalizeResult(result) });
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
    await Promise.all(selectedUploads.map((file) => discardUpload(file.id)));
    if (!res.writableEnded) res.end();
  }
}

async function handleArtifact(req, res, url, cors) {
  const resolved = await resolveArtifact(url.searchParams.get("path") || "");
  const content = await readFile(resolved);
  res.writeHead(200, {
    "Content-Type": mimeFromExtension(path.extname(resolved).toLowerCase()),
    "Content-Length": content.length,
    "Cache-Control": "private, max-age=120",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    ...cors,
  });
  res.end(content);
}

async function serveStatic(pathname, res) {
  const fileByPath = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/config.js": ["config.js", "text/javascript; charset=utf-8"],
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
    "Cache-Control": filename === "index.html" || filename === "config.js" ? "no-cache" : "public, max-age=300",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self' https://*.trycloudflare.com http://127.0.0.1:8787 http://localhost:8787; style-src 'self'; script-src 'self'; img-src 'self' blob: data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
      writeJson(res, 403, { error: "このサイトからは接続できません。" }, cors);
      return;
    }
    if (url.pathname.startsWith("/api/") && !authorized(req)) {
      writeJson(res, 401, { error: "アクセスキーを確認してください。" }, cors);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      writeJson(res, 200, {
        connected: true,
        running,
        workspace: path.basename(workspace),
        threadId: thread.id,
        networkAccess: networkAccessEnabled,
      }, cors);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      await handleUpload(req, res, cors);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/new") {
      if (running) {
        writeJson(res, 409, { error: "実行中は新しい設計を開始できません。" }, cors);
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
    if (req.method === "GET" && url.pathname === "/api/artifact") {
      await handleArtifact(req, res, url, cors);
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
  console.log(`Origami Codex: http://${host}:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Access key: ${accessKey}`);
  console.log("公開時もアクセスキーが必要です。");
});

async function loadOrCreateAccessKey() {
  const keyPath = path.join(root, ".codex-web-token");
  try {
    return (await readFile(keyPath, "utf8")).trim();
  } catch {
    const key = randomBytes(18).toString("base64url");
    await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
    return key;
  }
}

async function assertDirectory(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${directory}`);
}

async function discardUpload(id) {
  const upload = uploads.get(id);
  if (!upload) return;
  uploads.delete(id);
  await unlink(upload.path).catch(() => {});
}

function emptyResult(summary) {
  return {
    summary,
    prediction: { previewPath: null, filePath: null, caption: "" },
    oriedita: { previewPath: null, filePath: null, caption: "" },
    model: { previewPath: null, filePath: null, caption: "" },
    steps: [],
  };
}

async function normalizeResult(result) {
  const normalized = emptyResult(String(result?.summary || "設計が完了しました。"));
  for (const key of ["prediction", "oriedita", "model"]) {
    normalized[key] = {
      previewPath: await normalizeArtifactPath(result?.[key]?.previewPath),
      filePath: await normalizeArtifactPath(result?.[key]?.filePath),
      caption: String(result?.[key]?.caption || ""),
    };
  }
  normalized.steps = Array.isArray(result?.steps)
    ? await Promise.all(result.steps.slice(0, 80).map(async (step, index) => ({
        number: Number.isInteger(step?.number) ? step.number : index + 1,
        title: String(step?.title || `手順 ${index + 1}`),
        instruction: String(step?.instruction || ""),
        imagePath: await normalizeArtifactPath(step?.imagePath),
      })))
    : [];
  return normalized;
}

async function normalizeArtifactPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const absolute = await resolveArtifact(value);
    return path.relative(workspaceReal, absolute);
  } catch {
    return null;
  }
}

async function resolveArtifact(requestedPath) {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("成果物が見つかりません。");
  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(workspaceReal, requestedPath);
  const resolved = await realpath(candidate);
  if (resolved !== workspaceReal && !resolved.startsWith(`${workspaceReal}${path.sep}`)) {
    throw new Error("成果物へアクセスできません。");
  }
  const allowed = new Set([
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".pdf", ".txt", ".md",
    ".json", ".cp", ".fold", ".ori", ".obj", ".glb", ".gltf",
  ]);
  if (!allowed.has(path.extname(resolved).toLowerCase())) throw new Error("この成果物は表示できません。");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("成果物が見つかりません。");
  return resolved;
}

function mimeFromExtension(extension) {
  return {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".pdf": "application/pdf",
    ".json": "application/json", ".fold": "application/json", ".gltf": "model/gltf+json",
    ".glb": "model/gltf-binary", ".obj": "text/plain", ".cp": "text/plain",
    ".ori": "text/plain", ".md": "text/markdown", ".txt": "text/plain",
  }[extension] || "application/octet-stream";
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const upload of uploads.values()) {
    if (upload.createdAt < cutoff) void discardUpload(upload.id);
  }
}, 15 * 60 * 1000).unref();
