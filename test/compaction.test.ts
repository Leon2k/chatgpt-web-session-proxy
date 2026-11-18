import assert from "node:assert/strict";
import { test } from "node:test";
import { hasConversationCheckpoint, isCompactionRequest } from "../src/compaction.js";

test("recognizes OpenCode structured-summary compaction prompts", () => {
  assert.equal(isCompactionRequest([
    { role: "system", content: "normal system prompt" },
    { role: "user", content: "You MUST summarize the conversation above into a structured summary that will be given to another agent." },
  ]), true);
  assert.equal(isCompactionRequest([
    { role: "user", content: "Update the existing checkpoint in the conversation above into one consolidated summary." },
  ]), true);
});

test("does not classify ordinary summary requests as OpenCode compaction", () => {
  assert.equal(isCompactionRequest([{ role: "user", content: "Summarize this file." }]), false);
});

test("recognizes only complete conversation checkpoints", () => {
  const checkpoint = "<conversation-checkpoint>\n<summary>state</summary>\n<recent-context>new</recent-context>\n</conversation-checkpoint>";
  assert.equal(hasConversationCheckpoint([{ role: "system", content: checkpoint }]), true);
  assert.equal(hasConversationCheckpoint([{ role: "user", content: "<conversation-checkpoint> incomplete" }]), false);
});
