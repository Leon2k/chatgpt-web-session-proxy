import assert from "node:assert/strict";
import { test } from "node:test";
import { validChatGptConversationUrl } from "../src/sessions.js";

test("accepts direct and project ChatGPT conversation URLs", () => {
  assert.equal(
    validChatGptConversationUrl("https://chatgpt.com/c/01234567-89ab-cdef-0123-456789abcdef"),
    "https://chatgpt.com/c/01234567-89ab-cdef-0123-456789abcdef",
  );
  assert.equal(
    validChatGptConversationUrl("https://chatgpt.com/g/g-p-workspace/project/c/01234567-89ab-cdef-0123-456789abcdef"),
    "https://chatgpt.com/g/g-p-workspace/project/c/01234567-89ab-cdef-0123-456789abcdef",
  );
});

test("rejects non-ChatGPT and non-conversation URLs", () => {
  assert.equal(validChatGptConversationUrl("https://example.test/c/id"), undefined);
  assert.equal(validChatGptConversationUrl("https://chatgpt.com/g/g-p-workspace/project"), undefined);
});
