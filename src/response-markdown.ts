import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

function codeFenceFor(code: string): string {
  const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), match => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

function codeLanguage(node: HTMLElement): string {
  const header = node.querySelector('[data-markdown-copy="exclude"]');
  const label = Array.from(header?.children ?? [])
    .map(child => child.textContent?.trim().toLowerCase() ?? "")
    .find(Boolean) ?? "";
  const aliases: Record<string, string> = {
    "c++": "cpp",
    "c#": "csharp",
    javascript: "javascript",
    plaintext: "text",
    powershell: "powershell",
    typescript: "typescript",
  };
  return aliases[label] ?? label.replace(/[^a-z0-9_+#.-]/g, "");
}

function normalizeChatGptHtml(html: string): string {
  return html
    // Generated images are commonly wrapped in an interactive preview button.
    // Unwrap it before the generic UI-control removal drops its contents.
    .replace(/<button\b[^>]*>((?:(?!<button\b)[\s\S])*?<img\b[\s\S]*?)<\/button>/gi, "$1")
    .replace(/<button\b([^>]*)>[\s\S]*?<\/button>/gi, (button, attributes: string) => {
    if (!/\brole\s*=\s*["']checkbox["']/i.test(attributes)) return button;
    const checked = attributes.match(/\baria-checked\s*=\s*["'](true|false)["']/i)?.[1].toLowerCase();
    return checked === "true"
      ? '<span data-chatgpt-task-marker="checked">x</span>'
      : checked === "false" ? '<span data-chatgpt-task-marker="unchecked">x</span>' : button;
    });
}

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
converter.addRule("chatgptCodeBlock", {
  filter: node => node.nodeType === 1 && node.hasAttribute("data-chatgpt-copy-code"),
  replacement: (_content, node) => {
    const element = node as HTMLElement;
    const code = element.getAttribute("data-chatgpt-copy-code") ?? element.querySelector("code")?.textContent ?? "";
    const fence = codeFenceFor(code);
    return `\n\n${fence}${codeLanguage(element)}\n${code.replace(/\n$/, "")}\n${fence}\n\n`;
  },
});
converter.addRule("chatgptTaskMarker", {
  filter: node => node.nodeType === 1 && node.hasAttribute("data-chatgpt-task-marker"),
  replacement: (_content, node) => (node as HTMLElement).getAttribute("data-chatgpt-task-marker") === "checked" ? "[x] " : "[ ] ",
});
converter.addRule("chatgptImage", {
  filter: node => node.nodeType === 1 && node.nodeName === "IMG",
  replacement: (_content, node) => {
    const image = node as HTMLImageElement;
    const source = image.getAttribute("src")?.trim() ?? "";
    if (!/^(?:https?:|data:image\/)/i.test(source)) return "";
    const alt = (image.getAttribute("alt")?.trim() || "ChatGPT image")
      .replace(/[\[\]]/g, "");
    return `\n\n![${alt}](${source})\n\n`;
  },
});
converter.addRule("chatgptTableCellParagraph", {
  filter: node => node.nodeType === 1 && node.nodeName === "P" && ["TD", "TH"].includes(node.parentElement?.nodeName ?? ""),
  replacement: content => content,
});

export function responseMarkdown(text: string, html: string): string {
  // Preserve literal tool protocol and legacy payloads byte-for-byte.
  if (text.includes("[[PI_TOOL_CALL]]") || text.includes("<tool_call>") ||
      text.includes("PI_TOOL_CALL:") || text.trimStart().startsWith("{") ||
      text.includes("```tool")) return text;
  try {
    return converter.turndown(normalizeChatGptHtml(html)).trim() || text;
  } catch {
    return text;
  }
}
