import { test } from "node:test";
import assert from "node:assert/strict";

import { selectFinalReportText } from "../src/assignments.js";

// An assistant entry carrying plain-string content.
function assistant(content: string): { role: string; content: unknown } {
  return { role: "assistant", content };
}

test("selectFinalReportText returns the NEWEST assistant text when entries are descending", () => {
  // Descending order: newest first. The final report is the newest non-empty
  // assistant text, not the oldest preamble.
  const items = [
    { model: [assistant("Done: created 3 files and all tests passed.")] },
    { model: [{ role: "tool", content: "irrelevant" }] },
    { model: [assistant("I'll create the files now.")] },
  ];
  assert.equal(selectFinalReportText(items), "Done: created 3 files and all tests passed.");
});

test("selectFinalReportText skips empty and non-assistant messages", () => {
  const items = [
    { model: [assistant("   ")] }, // newest but empty/whitespace is skipped
    { model: [{ role: "user", content: "ignore me" }] },
    { model: [assistant("real report")] },
  ];
  assert.equal(selectFinalReportText(items), "real report");
});

test("selectFinalReportText joins text blocks and returns null when nothing matches", () => {
  const items = [
    { model: [{ role: "assistant", content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] }] },
  ];
  assert.equal(selectFinalReportText(items), "line one\nline two");
  assert.equal(selectFinalReportText([{ model: [] }, {}]), null);
});
