import assert from "node:assert/strict";
import { test } from "node:test";
import { responseMarkdown } from "../src/response-markdown.js";

test("preserves Markdown formatting", () => {
  const result = responseMarkdown("fallback", [
    "<h1>Heading 1</h1><h3>Heading 3</h3>",
    "<p><strong>Bold</strong> and <em>italic</em> with <a href=\"https://example.com\">Link</a></p>",
    "<ol><li>First<ol><li>Nested</li></ol></li><li>Second</li></ol>",
    "<blockquote><p>Quoted text</p></blockquote>",
    "<ul><li><input type=\"checkbox\" checked> Done</li><li><input type=\"checkbox\"> Todo</li></ul>",
  ].join(""));

  assert.ok(result.includes("# Heading 1"));
  assert.ok(result.includes("### Heading 3"));
  assert.ok(result.includes("**Bold**"));
  assert.ok(result.includes("*italic*"));
  assert.ok(result.includes("[Link](https://example.com)"));
  assert.match(result, /1\.\s+First\s+1\.\s+Nested/);
  assert.match(result, /2\.\s+Second/);
  assert.ok(result.includes("> Quoted text"));
  assert.match(result, /-\s+\[x\]\s+Done/i);
  assert.match(result, /-\s+\[ \]\s+Todo/);
});

test("preserves fenced code and GFM tables", () => {
const result = responseMarkdown("Code and table", `<pre><code class="language-js">const x = 1;</code></pre><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`);
assert.ok(result.includes("```js\nconst x = 1;\n```"));
assert.match(result, /\|\s*A\s*\|\s*B\s*\|/);
assert.match(result, /\|\s*1\s*\|\s*2\s*\|/);
});

test("converts current ChatGPT code, table, and task widgets", () => {
  const result = responseMarkdown("fallback", [
    '<div data-chatgpt-copy-code="const value = `demo`;\n"><div data-code-block="true">',
    '<div data-markdown-copy="exclude"><div>TypeScript</div><button>Copy</button></div>',
    '<pre><code><span>const value = `demo`;</span></code></pre></div></div>',
    '<table><tbody><tr><th><p>Feature</p></th><th><p>Status</p></th></tr>',
    '<tr><td><p>Markdown</p></td><td><p>Supported</p></td></tr></tbody></table>',
    '<ul data-d-marker="none"><li><button role="checkbox" aria-checked="true"></button><label>Done</label></li>',
    '<li><button role="checkbox" aria-checked="false"></button><label>Todo</label></li></ul>',
  ].join(""));

  assert.ok(result.includes("```typescript\nconst value = `demo`;\n```"));
  assert.match(result, /\|\s*Feature\s*\|\s*Status\s*\|/);
  assert.match(result, /\|\s*Markdown\s*\|\s*Supported\s*\|/);
  assert.match(result, /-\s+\[x\]\s+Done/i);
  assert.match(result, /-\s+\[ \]\s+Todo/);
});

test("preserves raw tool protocol", () => {
  const raw = [
    "[[PI_" + "TOOL_CALL]]",
    "name: write",
    "[[PI_" + "ARG:path]]",
    "example.ts",
    "[[/PI_" + "ARG]]",
    "[[PI_" + "ARG:content]]",
    "export function render(value: string) {",
    "  return `<section class=\"result\">${value}</section>`;",
    "}",
    "[[/PI_" + "ARG]]",
    "[[/PI_" + "TOOL_CALL]]",
  ].join("\n");
  assert.equal(responseMarkdown(raw, "<p>Different content</p>"), raw);
});

test("removes interface controls and SVG content", () => {
assert.equal(responseMarkdown("Answer Copy", "<p>Answer</p><button>Copy</button><svg><text>Icon</text></svg>"), "Answer");
});

test("falls back to plain text when HTML is empty", () => {
assert.equal(responseMarkdown("Original answer", ""), "Original answer");
});

test("preserves generated images wrapped in ChatGPT preview buttons", () => {
  const html = '<p>Created image:</p><button aria-label="Open image"><span><img alt="Blue square" src="https://files.example.test/generated.png"></span></button>';
  const markdown = responseMarkdown("Created image", html);
  assert.match(markdown, /Created image:/);
  assert.match(markdown, /!\[Blue square\]\(https:\/\/files\.example\.test\/generated\.png\)/);
});

test("drops browser-local blob images that OpenCode cannot load", () => {
  assert.equal(responseMarkdown("preview", '<img alt="preview" src="blob:https://chatgpt.com/id">'), "preview");
});

test("preserves portable data URLs for generated images", () => {
  const markdown = responseMarkdown("Edit", '<button data-testid="generated-image-preview"><img alt="Generated image 1" src="data:image/png;base64,AA=="></button>');
  assert.equal(markdown, "![Generated image 1](data:image/png;base64,AA==)");
});
