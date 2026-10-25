/**
 * Loads the skills the way pi does.
 *
 * pi drops a skill whose frontmatter does not parse, and in print mode it says
 * nothing. From 2026-10-22 (45439bd) to 2026-10-25, the description of
 * sleuth-answer held "without commands: the answer", which YAML reads as a
 * nested mapping, so every run went without the answer skill and no test saw it.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const skillsDir = join(import.meta.dirname, "..", "skills");

test("pi loads every skill, with no diagnostics", () => {
	const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: "test" });
	assert.deepEqual(
		diagnostics.map((d) => `${d.path ?? ""}: ${d.message}`),
		[],
	);
	const expected = readdirSync(skillsDir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name.startsWith("sleuth-"))
		.map((e) => e.name)
		.sort();
	assert.deepEqual(skills.map((s) => s.name).sort(), expected);
});
