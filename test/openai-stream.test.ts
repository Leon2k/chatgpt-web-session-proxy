import assert from "node:assert/strict";
import { test } from "node:test";
import { splitStreamContent, STREAM_CONTENT_CHUNK_CHARS } from "../src/openai.js";

test("splits large image Markdown into bounded SSE content deltas", () => {
  const content = `![Generated](data:image/png;base64,${"A".repeat(STREAM_CONTENT_CHUNK_CHARS * 3 + 517)})`;
  const chunks = splitStreamContent(content);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every(chunk => chunk.length <= STREAM_CONTENT_CHUNK_CHARS));
  assert.equal(chunks.join(""), content);
});

test("does not emit an empty content chunk", () => {
  assert.deepEqual(splitStreamContent(""), []);
});
