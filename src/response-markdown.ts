import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const converter = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
});
converter.use(gfm);
converter.remove(["button", "script", "style", "input", "select", "textarea"]);
converter.remove(node => node.nodeName.toLowerCase() === "svg");

export function responseMarkdown(text: string, html: string): string {
  // Preserve literal tool protocol and legacy payloads byte-for-byte.
  if (text.includes("[[PI_TOOL_CALL]]") || text.includes("<tool_call>") ||
      text.includes("PI_TOOL_CALL:") || text.trimStart().startsWith("{") ||
      text.includes("```tool")) return text;
  try {
    return converter.turndown(html).trim() || text;
  } catch {
    return text;
  }
}
