import assert from "node:assert/strict";
import test from "node:test";
import { decodeEncodedAttachments, extractFileAttachments, InvalidFileAttachmentError, MAX_FILE_BYTES } from "../src/attachments.js";
import type { ChatMessage } from "../src/types.js";

test("decodes OpenAI Chat PDF file parts", () => {
  const messages: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        filename: "manual.pdf",
        file_data: `data:application/pdf;base64,${Buffer.from("%PDF-test").toString("base64")}`,
      },
    }],
  }];
  const [file] = extractFileAttachments(messages);
  assert.equal(file.name, "manual.pdf");
  assert.equal(file.mimeType, "application/pdf");
  assert.equal(file.buffer.toString(), "%PDF-test");
});

test("decodes plugin-provided arbitrary files and strips paths", () => {
  const [file] = decodeEncodedAttachments([{
    name: "../../notes.txt",
    mimeType: "text/plain",
    data: Buffer.from("ATTACHMENT_OK").toString("base64"),
  }]);
  assert.equal(file.name, "notes.txt");
  assert.equal(file.mimeType, "text/plain");
  assert.equal(file.buffer.toString(), "ATTACHMENT_OK");
});

test("rejects invalid base64 and oversized arbitrary files", () => {
  assert.throws(() => decodeEncodedAttachments([{ name: "bad.bin", mimeType: "application/octet-stream", data: "%%%=" }]), InvalidFileAttachmentError);
  assert.throws(() => decodeEncodedAttachments([{
    name: "large.bin",
    mimeType: "application/octet-stream",
    data: Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64"),
  }]), InvalidFileAttachmentError);
});
