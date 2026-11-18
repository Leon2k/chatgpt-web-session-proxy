import assert from "node:assert/strict";
import { test } from "node:test";
import { extractImageAttachments, InvalidImageAttachmentError } from "../src/images.js";

test("decodes OpenAI image_url data attachments", () => {
  const images = extractImageAttachments([{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
  ] }]);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[0].buffer.toString(), "hello");
  assert.match(images[0].name, /^image-1-[a-f0-9]{12}\.png$/);
});

test("accepts Responses-style input_image parts", () => {
  const images = extractImageAttachments([{ role: "user", content: [
    { type: "input_image", image_url: "data:image/jpeg;base64,aGk=" },
  ] }]);
  assert.equal(images[0].mimeType, "image/jpeg");
});

test("does not fetch external image URLs", () => {
  assert.throws(() => extractImageAttachments([{ role: "user", content: [
    { type: "image_url", image_url: { url: "http://127.0.0.1/private.png" } },
  ] }]), InvalidImageAttachmentError);
});

test("rejects image formats ChatGPT Web cannot submit", () => {
  assert.throws(() => extractImageAttachments([{ role: "user", content: [
    { type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zy8+" } },
  ] }]), /Unsupported image MIME type/);
});
