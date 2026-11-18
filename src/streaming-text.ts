const TOOL_PROTOCOL_STARTS = [
  "[[PI_TOOL_CALL]]",
  "<tool_call>",
  "PI_TOOL_CALL:",
  "```tool",
  "tool\n",
];

function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function toolProtocolState(text: string): "possible" | "tool" | "normal" {
  const trimmed = text.trimStart();
  if (!trimmed) return "possible";
  if (trimmed.startsWith("{")) return "possible";
  for (const marker of TOOL_PROTOCOL_STARTS) {
    if (trimmed.startsWith(marker)) return "tool";
    if (marker.startsWith(trimmed)) return "possible";
  }
  return "normal";
}

/**
 * Turns changing full DOM snapshots into append-only text deltas. A small tail
 * is retained until the next snapshot so Turndown can still rewrite the active
 * Markdown construct (for example a growing code fence or table row).
 */
export class IncrementalMarkdown {
  private previous = "";
  private emitted = "";
  private classifiedNormal: boolean;
  private toolDetected = false;

  constructor(private readonly toolAware: boolean, private readonly holdback = 32) {
    this.classifiedNormal = !toolAware;
  }

  update(rawText: string, markdown: string): string {
    if (this.toolAware && !this.classifiedNormal) {
      const state = toolProtocolState(rawText);
      if (state === "tool") this.toolDetected = true;
      if (state !== "normal") {
        this.previous = markdown;
        return "";
      }
      this.classifiedNormal = true;
    }

    if (this.toolDetected || !markdown.startsWith(this.emitted)) {
      this.previous = markdown;
      return "";
    }

    if (!this.previous) {
      this.previous = markdown;
      return "";
    }

    const shared = sharedPrefixLength(this.previous, markdown);
    const target = Math.max(this.emitted.length, shared - this.holdback);
    let boundary = target;
    while (boundary > this.emitted.length && !/\s/.test(markdown[boundary - 1])) boundary -= 1;
    const delta = markdown.slice(this.emitted.length, boundary);
    if (delta) this.emitted += delta;
    this.previous = markdown;
    return delta;
  }

  finish(finalContent: string): string {
    if (!finalContent.startsWith(this.emitted)) {
      throw new Error("Final Markdown diverged from the already streamed prefix.");
    }
    const delta = finalContent.slice(this.emitted.length);
    this.emitted = finalContent;
    return delta;
  }

  get hasEmittedText(): boolean {
    return this.emitted.length > 0;
  }
}
