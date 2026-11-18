import assert from "node:assert/strict";
import { test } from "node:test";
import { IncrementalMarkdown } from "../src/streaming-text.js";

test("emits stable Markdown deltas and reconstructs the final response", () => {
  const stream = new IncrementalMarkdown(false, 8);
  const chunks = [
    stream.update("Heading and", "# Heading\n\nParagraph and"),
    stream.update("Heading and growing text", "# Heading\n\nParagraph and growing text"),
    stream.update("Heading and growing text done", "# Heading\n\nParagraph and growing text done"),
  ].filter(Boolean);
  const final = "# Heading\n\nParagraph and growing text done.";
  chunks.push(stream.finish(final));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), final);
});

test("buffers partial and complete tool protocol markers", () => {
  const stream = new IncrementalMarkdown(true, 4);
  assert.equal(stream.update("[[PI_", "[[PI_"), "");
  assert.equal(stream.update("[[PI_TOOL_CALL]]\nname: write", "[[PI_TOOL_CALL]]\nname: write"), "");
  assert.equal(stream.update("[[PI_TOOL_CALL]]\nname: write\n[[PI_ARG:path]]", "[[PI_TOOL_CALL]]\nname: write\n[[PI_ARG:path]]"), "");
  assert.equal(stream.hasEmittedText, false);
});

test("streams a normal answer even when tools were offered", () => {
  const stream = new IncrementalMarkdown(true, 4);
  assert.equal(stream.update("Normal answer starts", "Normal answer starts"), "");
  const delta = stream.update("Normal answer starts growing now", "Normal answer starts growing now");
  assert.ok(delta.length > 0);
  const final = "Normal answer starts growing now.";
  assert.equal(delta + stream.finish(final), final);
});
