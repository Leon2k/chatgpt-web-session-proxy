import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPACTION_TRANSCRIPT_BUDGET,
  compactionTurn,
  hasConversationCheckpoint,
  isCompactionRequest,
  prepareCompactionMessages,
} from "../src/compaction.js";
import { buildInitialPrompt } from "../src/transcript.js";

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

test("bounds large compaction transcripts while retaining the final instruction", () => {
  const instruction = "You MUST summarize the conversation above into a structured summary that will be given to another agent.";
  const messages = [
    { role: "system" as const, content: "x".repeat(100_000) },
    ...Array.from({ length: 30 }, (_, index) => ({
      role: "tool" as const,
      tool_call_id: `call-${index}`,
      content: `tool ${index}\n${"y".repeat(20_000)}`,
    })),
    { role: "user" as const, content: instruction },
  ];

  const prepared = prepareCompactionMessages(messages);
  const prompt = buildInitialPrompt(prepared, []);
  assert.equal(prepared.some(message => message.role === "system"), false);
  assert.equal(prepared.at(-1)?.content, instruction);
  assert.match(String(prepared[0]?.content), /Older transcript entries were omitted/);
  assert.ok(prompt.length < COMPACTION_TRANSCRIPT_BUDGET + 5_000, `prompt was ${prompt.length} characters`);
});

test("truncates tool-call arguments without changing their protocol fields", () => {
  const prepared = prepareCompactionMessages([
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "a".repeat(20_000) } }],
    },
    { role: "user", content: "Update the existing checkpoint in the conversation above into one consolidated summary." },
  ]);
  const call = prepared[0]?.tool_calls?.[0];
  assert.equal(call?.id, "call-1");
  assert.equal(call?.type, "function");
  assert.equal(call?.function.name, "bash");
  assert.match(call?.function.arguments ?? "", /characters omitted/);
  assert.ok((call?.function.arguments.length ?? Infinity) <= 3_000);
});

test("treats quoted tool markers in a compaction checkpoint as summary text", () => {
  const checkpoint = "<conversation-checkpoint><summary>Protocol used [[PI_TOOL_CALL]] markers.</summary></conversation-checkpoint>";
  assert.deepEqual(compactionTurn(checkpoint), {
    rawText: checkpoint,
    content: checkpoint,
    toolCalls: [],
    finishReason: "stop",
  });
});
