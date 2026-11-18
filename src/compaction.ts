import { contentToText } from "./transcript.js";
import type { AssistantTurn, ChatMessage } from "./types.js";

const COMPACTION_PROMPT_MARKERS = [
  "You MUST summarize the conversation above into a structured summary",
  "Update the existing checkpoint in the conversation above into one consolidated summary",
  "The previous response did not fill in the required summary template",
];

// A full OpenCode transcript can contain hundreds of kilobytes of tool output.
// Inserting that directly into ChatGPT's contenteditable composer makes Chromium
// retain several copies of the DOM text and can exhaust the service's memory.
// Keep enough recent context for a useful checkpoint while bounding both each
// individual payload and the complete transcript sent to the temporary page.
export const COMPACTION_TRANSCRIPT_BUDGET = 48_000;
const COMPACTION_MESSAGE_LIMIT = 6_000;
const COMPACTION_TOOL_ARGUMENT_LIMIT = 3_000;
const COMPACTION_TOOL_CALL_LIMIT = 8;
const OMITTED_HISTORY_NOTE = "[Older transcript entries were omitted by the proxy to fit the ChatGPT Web composer. Preserve unresolved work from the retained recent history.]";
const COMPACTION_HEADING = /^## (Objective|Requirements|Decisions|Work State|Next Move|Relevant Files|Important Context)\s*$/m;

function truncateMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = `\n[... ${value.length - limit} characters omitted ...]\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return value.slice(0, head) + marker + value.slice(value.length - (available - head));
}

function compactMessage(message: ChatMessage): ChatMessage {
  const content = truncateMiddle(contentToText(message.content), COMPACTION_MESSAGE_LIMIT);
  const toolCalls = message.tool_calls?.slice(0, COMPACTION_TOOL_CALL_LIMIT).map(call => ({
    ...call,
    id: truncateMiddle(call.id, 200),
    function: {
      name: truncateMiddle(call.function.name, 200),
      arguments: truncateMiddle(call.function.arguments, COMPACTION_TOOL_ARGUMENT_LIMIT),
    },
  }));
  return {
    role: message.role,
    content,
    ...(message.name ? { name: truncateMiddle(message.name, 200) } : {}),
    ...(message.tool_call_id ? { tool_call_id: truncateMiddle(message.tool_call_id, 200) } : {}),
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  };
}

function messageSize(message: ChatMessage): number {
  return JSON.stringify(message).length;
}

export function prepareCompactionMessages(
  messages: ChatMessage[],
  budget = COMPACTION_TRANSCRIPT_BUDGET,
): ChatMessage[] {
  const eligible = messages.filter(message => message.role !== "system" && message.role !== "developer");
  const selected: ChatMessage[] = [];
  let size = 0;
  let omitted = messages.length - eligible.length;

  for (let index = eligible.length - 1; index >= 0; index--) {
    const compacted = compactMessage(eligible[index]);
    const nextSize = messageSize(compacted);
    if (size + nextSize > budget && selected.length) {
      omitted += index + 1;
      break;
    }
    selected.unshift(compacted);
    size += nextSize;
  }

  if (omitted > 0) {
    const note: ChatMessage = { role: "user", content: OMITTED_HISTORY_NOTE };
    while (selected.length > 1 && size + messageSize(note) > budget) {
      size -= messageSize(selected.shift()!);
    }
    selected.unshift(note);
  }
  return selected;
}

export function compactionTurn(content: string): AssistantTurn {
  // OpenCode 2.x accepts a checkpoint only when at least one line exactly
  // matches a heading from its summary template. ChatGPT Web occasionally
  // returns an otherwise useful summary inside old XML wrappers or as prose.
  const normalized = COMPACTION_HEADING.test(content)
    ? content
    : `## Important Context\n${content}`;
  return { rawText: normalized, content: normalized, toolCalls: [], finishReason: "stop" };
}

export function isCompactionRequest(messages: ChatMessage[]): boolean {
  const lastUser = messages.findLast(message => message.role === "user");
  const text = contentToText(lastUser?.content);
  return COMPACTION_PROMPT_MARKERS.some(marker => text.includes(marker));
}

export function hasConversationCheckpoint(messages: ChatMessage[]): boolean {
  return messages.some(message => {
    const text = contentToText(message.content);
    return text.includes("<conversation-checkpoint>") &&
      text.includes("<summary>") &&
      text.includes("</conversation-checkpoint>");
  });
}
