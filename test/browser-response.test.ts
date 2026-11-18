import assert from "node:assert/strict";
import { test } from "node:test";
import { selectNewAssistantResponse, type AssistantResponseSnapshot } from "../src/browser.js";

const response = (id: string, text: string): AssistantResponseSnapshot => ({
  id,
  text,
  html: text ? `<p>${text}</p>` : "",
  state: "complete",
});

test("selects the new answer before an empty trailing placeholder", () => {
  const before = new Set(["old"]);
  const responses = [
    response("old", "previous answer"),
    response("new", "formatted answer"),
    response("old", ""),
  ];
  assert.equal(selectNewAssistantResponse(responses, before)?.id, "new");
});

test("waits while a new assistant response is still empty", () => {
  assert.equal(selectNewAssistantResponse([response("new", "")], new Set()), undefined);
});

test("uses the newest non-empty response created by the turn", () => {
  const responses = [response("new-1", "draft"), response("new-2", "final")];
  assert.equal(selectNewAssistantResponse(responses, new Set())?.id, "new-2");
});
