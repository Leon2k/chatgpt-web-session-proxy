import { contentToText } from "./transcript.js";
import type { ChatMessage } from "./types.js";

const COMPACTION_PROMPT_MARKERS = [
  "You MUST summarize the conversation above into a structured summary",
  "Update the existing checkpoint in the conversation above into one consolidated summary",
  "The previous response did not fill in the required summary template",
];

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
