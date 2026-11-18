import crypto from "node:crypto";
import type { ChatMessage, ImageAttachment, ImageUrlContentPart } from "./types.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 10;

const EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const SUPPORTED_IMAGE_MIMES = new Set(Object.keys(EXTENSIONS));

export class InvalidImageAttachmentError extends Error {
  override name = "InvalidImageAttachmentError";
}

export function imageUrl(part: ImageUrlContentPart): string {
  return typeof part.image_url === "string" ? part.image_url : part.image_url.url;
}

export function imageParts(content: ChatMessage["content"]): ImageUrlContentPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ImageUrlContentPart =>
    part?.type === "image_url" || part?.type === "input_image"
  );
}

export function imageReferenceHashes(content: ChatMessage["content"]): string[] {
  return imageParts(content).map(part =>
    crypto.createHash("sha256").update(imageUrl(part)).digest("hex")
  );
}

function decodeImage(part: ImageUrlContentPart, index: number): ImageAttachment {
  const url = imageUrl(part);
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url);
  if (!match) {
    throw new InvalidImageAttachmentError(
      "Only base64 data:image/... attachments are supported. External image URLs are intentionally not fetched.",
    );
  }
  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_MIMES.has(mimeType)) {
    throw new InvalidImageAttachmentError(`Unsupported image MIME type: ${mimeType}. Use PNG, JPEG, WebP, GIF, or AVIF.`);
  }
  const encoded = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) throw new InvalidImageAttachmentError("Image attachment is empty.");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new InvalidImageAttachmentError(`Image attachment exceeds the ${MAX_IMAGE_BYTES} byte limit.`);
  }
  const digest = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const extension = EXTENSIONS[mimeType];
  return { name: `image-${index + 1}-${digest}.${extension}`, mimeType, buffer };
}

export function extractImageAttachments(messages: ChatMessage[]): ImageAttachment[] {
  const parts = messages.flatMap(message => imageParts(message.content));
  if (parts.length > MAX_IMAGES_PER_TURN) {
    throw new InvalidImageAttachmentError(`A turn may contain at most ${MAX_IMAGES_PER_TURN} images.`);
  }
  return parts.map(decodeImage);
}
