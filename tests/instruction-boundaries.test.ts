import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CODEX_REPO_GUIDANCE } from "../src/codex-repo-guidance.js";
import { PI_WORKER_POLICY } from "../src/worker-instructions.js";

test("distributed repository templates and Codex skills cannot inherit the Pi-only policy", async () => {
  for (const file of ["AGENTS.md", "docs/AGENTS-PI-TEMPLATE.md"]) {
    assert.equal(await readFile(file, "utf8"), CODEX_REPO_GUIDANCE, file + " drifted from the new-project template");
  }
  for (const dir of ["skill/pi-durable", "plugin/skills/pi-durable-manager"]) {
    for (const file of ["SKILL.md", "references/advanced-operations.md", "references/instruction-boundaries.md"]) {
      const text = await readFile(dir + "/" + file, "utf8");
      assert.ok(!text.includes(PI_WORKER_POLICY), "worker policy leaked into manager instructions");
      assert.doesNotMatch(text, /No subagents, commits|No automated commits, pushes|limits always apply/);
    }
  }
  assert.equal(await readFile("skill/pi-durable/references/instruction-boundaries.md", "utf8"),
    await readFile("plugin/skills/pi-durable-manager/references/instruction-boundaries.md", "utf8"));
});
