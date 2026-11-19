import { Plugin } from "@opencode/plugin";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_URL = process.env.CHATGPT_WEB_PROXY_URL ?? "http://127.0.0.1:4153";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac", ".avi": "video/x-msvideo", ".csv": "text/csv", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".gif": "image/gif",
  ".html": "text/html", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".json": "application/json",
  ".md": "text/markdown", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".mp3": "audio/mpeg",
  ".mp4": "video/mp4", ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf", ".png": "image/png", ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".py": "text/x-python",
  ".rtf": "application/rtf", ".svg": "image/svg+xml", ".tar": "application/x-tar", ".text": "text/plain",
  ".ts": "text/typescript", ".txt": "text/plain", ".wav": "audio/wav", ".webm": "video/webm", ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml", ".zip": "application/zip",
};

type PendingFile = { uri: string; name?: string; description?: string; source?: unknown; mention?: unknown };
type EncodedFile = { name: string; mimeType: string; data: string };

const inferMime = (name: string, explicit?: string) => explicit || MIME_BY_EXTENSION[path.extname(name).toLowerCase()] || "application/octet-stream";

async function resolveFile(file: PendingFile): Promise<EncodedFile> {
  const dataMatch = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(file.uri);
  if (dataMatch) {
    const bytes = Buffer.from(dataMatch[2].replace(/\s+/g, ""), "base64");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error(`Attachment ${file.name ?? "file"} is empty or exceeds 20 MiB.`);
    return { name: file.name || "attachment", mimeType: dataMatch[1].toLowerCase(), data: bytes.toString("base64") };
  }

  let bytes: Buffer;
  let sourceName = file.name;
  let responseType: string | undefined;
  if (file.uri.startsWith("file:")) {
    const filename = fileURLToPath(file.uri);
    bytes = await readFile(filename);
    sourceName ||= path.basename(filename);
  } else if (/^https?:\/\//i.test(file.uri)) {
    const response = await fetch(file.uri);
    if (!response.ok) throw new Error(`Could not read attachment ${file.uri}: HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_FILE_BYTES) throw new Error(`Attachment ${sourceName ?? file.uri} exceeds 20 MiB.`);
    bytes = Buffer.from(await response.arrayBuffer());
    responseType = response.headers.get("content-type")?.split(";", 1)[0];
    sourceName ||= path.basename(new URL(file.uri).pathname);
  } else {
    bytes = await readFile(file.uri);
    sourceName ||= path.basename(file.uri);
  }
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error(`Attachment ${sourceName ?? "file"} is empty or exceeds 20 MiB.`);
  const name = sourceName || "attachment";
  return { name, mimeType: inferMime(name, responseType), data: bytes.toString("base64") };
}

async function proxyRequest(pathname: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${PROXY_URL}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`ChatGPT proxy ${init.method ?? "GET"} ${pathname} returned HTTP ${response.status}: ${await response.text()}`);
}

async function retry(label: string, action: () => Promise<void>): Promise<void> {
  let last: unknown;
  for (const delay of [0, 500, 1_500, 4_000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { await action(); return; } catch (error) { last = error; }
  }
  console.error(`[chatgpt-web-session-proxy] ${label} failed`, last);
}

export default Plugin.define({
  id: "chatgpt-web-session-proxy",
  async setup(ctx) {
    const controller = new AbortController();
    let lifecycleTail = Promise.resolve();
    const lifecycleRoot = process.env.OPENCODE_LIFECYCLE_ROOT ?? "/srv/projects";

    if (ctx.location.directory === lifecycleRoot) {
      void (async () => {
        for await (const event of ctx.event.subscribe({
          types: ["session.archived", "session.unarchived", "session.deleted"],
          signal: controller.signal,
        })) {
          const sessionID = event.data.sessionID;
          lifecycleTail = lifecycleTail.then(() => retry(`${event.type} ${sessionID}`, async () => {
            if (event.type === "session.deleted") {
              await proxyRequest(`/v1/sessions/${encodeURIComponent(sessionID)}/lifecycle/remote`, { method: "DELETE" });
              return;
            }
            await proxyRequest(`/v1/sessions/${encodeURIComponent(sessionID)}/lifecycle/archive`, {
              method: "POST",
              body: JSON.stringify({ archived: event.type === "session.archived" }),
            });
          }));
        }
      })().catch(error => {
        if (!controller.signal.aborted) console.error("[chatgpt-web-session-proxy] lifecycle subscription failed", error);
      });
    }

    const promptHook = await ctx.session.hook("prompt", async (event) => {
      const response = await ctx.session.get({ sessionID: event.sessionID });
      const session = (response as { data?: unknown }).data ?? response;
      const model = (session as { model?: { providerID?: string } }).model;
      if (model?.providerID !== "chatgpt-web") return;

      const files = (event.prompt.files ?? []) as PendingFile[];
      const passthrough: PendingFile[] = [];
      const handled: EncodedFile[] = [];
      for (const file of files) {
        const dataMime = /^data:([^;,]+)/i.exec(file.uri)?.[1];
        const name = file.name || (file.uri.startsWith("file:") ? path.basename(fileURLToPath(file.uri)) : path.basename(file.uri));
        const mime = inferMime(name, dataMime);
        if (mime.startsWith("image/") && mime !== "image/svg+xml") passthrough.push(file);
        else handled.push(await resolveFile(file));
      }
      if (!handled.length) return;

      await proxyRequest(`/v1/sessions/${encodeURIComponent(event.sessionID)}/attachments`, {
        method: "POST",
        body: JSON.stringify({ files: handled }),
      });
      event.prompt.files = passthrough;
      event.prompt.text = [event.prompt.text, ...handled.map(file => `[Attached file: ${file.name} (${file.mimeType})]`)].filter(Boolean).join("\n\n");
    });

    const httpHook = await ctx.session.hook(
      "http.request",
      event => event.request.headers.set("x-opencode-request-kind", event.kind),
      { providerID: "chatgpt-web" },
    );

    return async () => {
      controller.abort();
      await Promise.allSettled([promptHook.dispose(), httpHook.dispose(), lifecycleTail]);
    };
  },
});
