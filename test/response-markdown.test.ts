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
