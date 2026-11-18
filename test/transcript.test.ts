import test from "node:test";
import assert from "node:assert/strict";
import { buildDeltaPrompt, changedInstructionMessages, commonPrefixLength } from "../src/transcript.js";
import type { ChatMessage } from "../src/types.js";

test("append-only transcript prefix", () => {
  const a: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: "a" }];
  assert.equal(commonPrefixLength(a, [...a, { role: "user", content: "next" }]), 3);
});

test("divergence is detected", () => {
  assert.equal(commonPrefixLength([{ role: "user", content: "one" }], [{ role: "user", content: "two" }]), 0);
});

test("regenerated OpenCode system prompts do not diverge an append-only chat", () => {
  const previous: ChatMessage[] = [
    { role: "system", content: "harness with initial capabilities" },
    { role: "user", content: "describe the attachment" },
    { role: "assistant", content: "description" },
  ];
  const next: ChatMessage[] = [
    { role: "system", content: "regenerated harness with updated capabilities" },
    { role: "user", content: "describe the attachment" },
    { role: "assistant", content: "description" },
    { role: "user", content: "continue" },
  ];
  assert.equal(commonPrefixLength(previous, next), previous.length);
  assert.deepEqual(changedInstructionMessages(previous, next, previous.length), [next[0]]);
});

test("image attachments participate in transcript identity", () => {
  const first: ChatMessage = { role: "user", content: [
    { type: "text", text: "describe" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
  ] };
  const second: ChatMessage = { role: "user", content: [
    { type: "text", text: "describe" },
    { type: "image_url", image_url: { url: "data:image/png;base64,Yg==" } },
  ] };
  assert.equal(commonPrefixLength([first], [second]), 0);
});

test("renders image attachment markers without embedding base64 in the prompt", () => {
  const prompt = buildDeltaPrompt([{ role: "user", content: [
    { type: "text", text: "describe" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
  ] }], []);
  assert.match(prompt, /\[Attached image 1: image\/png\]/);
  assert.doesNotMatch(prompt, /YQ==/);
});
