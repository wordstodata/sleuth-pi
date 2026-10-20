/**
 * The write gate is the safety property of this package, so it is tested here
 * rather than trusted: `w2d_raw` reaches the CLI directly, and everything that
 * writes has to be refused on its way through.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { addFlags, boundOutput, GATED_WRITE_SUBCOMMANDS, HUMAN_ONLY_SUBCOMMANDS, READ_ONLY_SUBCOMMANDS, rawCommandError } from "../src/w2d-common.ts";

test("every read-only subcommand passes w2d_raw", () => {
	for (const command of READ_ONLY_SUBCOMMANDS) {
		assert.equal(rawCommandError(command, []), undefined, command);
	}
});

test("settle --explain reads; settle --verdict and bare settle do not", () => {
	assert.equal(rawCommandError("settle", ["--link", "abc", "--explain"]), undefined);
	assert.match(rawCommandError("settle", ["--link", "abc", "--verdict", "confirmed"]) ?? "", /does not write/);
	assert.match(rawCommandError("settle", ["--link", "abc"]) ?? "", /only with --explain/);
});

test("every writer is refused, whatever the session was granted", () => {
	for (const command of GATED_WRITE_SUBCOMMANDS) {
		assert.match(rawCommandError(command, ["--verdict"]) ?? "", /does not write|w2d_\* tool/, command);
	}
});

test("batch steps and builders are refused outright, even with the grant", () => {
	for (const command of HUMAN_ONLY_SUBCOMMANDS) {
		const refusal = rawCommandError(command, []);
		assert.match(refusal ?? "", /batch step a person runs|output path is the dataset in force/, command);
	}
	// The one that would have destroyed the dataset in force: build-dataset
	// takes its output as the positional the runner fills with the dataset.
	assert.match(rawCommandError("build-dataset", ["--uslm-dates", "2025-07-18"]) ?? "", /output path is the dataset in force/);
});

test("an unknown subcommand is refused as a gap, not run", () => {
	assert.match(rawCommandError("link-by-evidence-x", []) ?? "", /gap in this package/);
});

test("bounded output names the way out; short output is untouched", () => {
	assert.equal(boundOutput("short output", 100, "words_to_data info"), "short output");
	const long = boundOutput("x".repeat(200), 100, "words_to_data search the --json");
	assert.ok(long.startsWith("x".repeat(100)));
	assert.match(long, /Truncated at 100 characters/);
	assert.match(long, /--path, --work, --at, --bill/);
	assert.match(long, /words_to_data search the --json/);
	// A truncated JSON array cannot be parsed, so never tell the model to add --json.
	assert.doesNotMatch(long, /re-run with --json/);
});

test("addFlags appends only what is set", () => {
	const spec = {
		bill: { flag: "--bill" },
		all: { flag: "--all", kind: "flag" as const },
		paths: { flag: "--path", kind: "list" as const },
		limit: { flag: "--limit" },
	};
	assert.deepEqual(
		addFlags(["annotations"], { bill: "119-hr-1", all: true, paths: ["a", "b"], limit: 5 }, spec),
		["annotations", "--bill", "119-hr-1", "--all", "--path", "a", "--path", "b", "--limit", "5"],
	);
	assert.deepEqual(addFlags(["annotations"], { bill: "", all: false, paths: [], limit: undefined }, spec), ["annotations"]);
});
