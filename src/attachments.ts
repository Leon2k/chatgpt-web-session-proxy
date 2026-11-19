import crypto from "node:crypto";
import path from "node:path";
import type { ChatMessage, FileAttachment, FileContentPart, VideoUrlContentPart } from "./types.js";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_TURN = 10;

export type EncodedAttachment = {
  name: string;
  mimeType: string;
  data: string;
};

export class InvalidFileAttachmentError extends Error {
  override name = "InvalidFileAttachmentError";
}

function safeName(value: string | undefined, fallback: string): string {
  const name = path.basename((value ?? "").replace(/[\u0000-\u001f\u007f]/g, "")).trim();
  return name && name !== "." ? name.slice(0, 240) : fallback;
}

function safeMime(value: string | undefined): string {
  const mime = (value ?? "application/octet-stream").trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    throw new InvalidFileAttachmentError(`Invalid attachment MIME type: ${JSON.stringify(value)}.`);
  }
  return mime;
}

function decodeBase64(data: string, label: string): Buffer {
  const compact = data.replace(/\s+/g, "");
  if (!compact || !/^[a-z0-9+/]*={0,2}$/i.test(compact) || compact.length % 4 !== 0) {
    throw new InvalidFileAttachmentError(`${label} is not valid base64.`);
  }
  const buffer = Buffer.from(compact, "base64");
  if (!buffer.length) throw new InvalidFileAttachmentError(`${label} is empty.`);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new InvalidFileAttachmentError(`${label} exceeds the ${MAX_FILE_BYTES} byte limit.`);
  }
  return buffer;
}

function decodeDataUrl(value: string, fallbackMime?: string): { mimeType: string; buffer: Buffer } {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (match) return { mimeType: safeMime(match[1]), buffer: decodeBase64(match[2], "Attachment") };
  return { mimeType: safeMime(fallbackMime), buffer: decodeBase64(value, "Attachment") };
}

export function fileParts(content: ChatMessage["content"]): Array<FileContentPart | VideoUrlContentPart> {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is FileContentPart | VideoUrlContentPart =>
    part?.type === "file" || part?.type === "input_file" || part?.type === "video_url" || part?.type === "input_video"
  );
}

function decodePart(part: FileContentPart | VideoUrlContentPart, index: number): FileAttachment {
  if (part.type === "video_url" || part.type === "input_video") {
    const url = typeof part.video_url === "string" ? part.video_url : part.video_url.url;
    const decoded = decodeDataUrl(url, "video/mp4");
    const digest = crypto.createHash("sha256").update(decoded.buffer).digest("hex").slice(0, 12);
    return { name: `video-${index + 1}-${digest}`, mimeType: decoded.mimeType, buffer: decoded.buffer };
  }

  const filePart = part as FileContentPart;
  const fileData = filePart.file?.file_data ?? filePart.file_data;
  if (!fileData) throw new InvalidFileAttachmentError("File attachment has no file_data payload.");
  const decoded = decodeDataUrl(fileData, "application/octet-stream");
  const digest = crypto.createHash("sha256").update(decoded.buffer).digest("hex").slice(0, 12);
  return {
    name: safeName(filePart.file?.filename ?? filePart.filename, `file-${index + 1}-${digest}`),
    mimeType: decoded.mimeType,
    buffer: decoded.buffer,
  };
}

export function extractFileAttachments(messages: ChatMessage[]): FileAttachment[] {
  const parts = messages.flatMap(message => fileParts(message.content));
  if (parts.length > MAX_FILES_PER_TURN) {
    throw new InvalidFileAttachmentError(`A turn may contain at most ${MAX_FILES_PER_TURN} files.`);
  }
  return parts.map(decodePart);
}

export function decodeEncodedAttachments(files: EncodedAttachment[]): FileAttachment[] {
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_TURN) {
    throw new InvalidFileAttachmentError(`A turn may contain at most ${MAX_FILES_PER_TURN} files.`);
  }
  return files.map((file, index) => ({
    name: safeName(file?.name, `file-${index + 1}`),
    mimeType: safeMime(file?.mimeType),
    buffer: decodeBase64(file?.data ?? "", `Attachment ${index + 1}`),
  }));
}

export function fileReferenceHashes(content: ChatMessage["content"]): string[] {
  return fileParts(content).map(part => crypto.createHash("sha256").update(JSON.stringify(part)).digest("hex"));
}
