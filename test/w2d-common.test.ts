/**
 * The write gate is the safety property of this package, so it is tested here
 * rather than trusted: `w2d_raw` reaches the CLI directly, and everything that
 * writes has to be refused on its way through.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	addFlags,
	boundOutput,
	compactJson,
	GATED_WRITE_SUBCOMMANDS,
	HUMAN_ONLY_SUBCOMMANDS,
	placeholderReasonError,
	quotesSource,
	quoteWords,
	READ_ONLY_SUBCOMMANDS,
	rawCommandError,
	unquotedReasonError,
} from "../src/w2d-common.ts";

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

// words-to-data #350: carry-reviews reads an old dataset and writes the carried
// reviews into the new one in one batch, so it is a step of a person's rebuild.
test("carry-reviews is refused as a batch step, not as an unknown command", () => {
	const refusal = rawCommandError("carry-reviews", ["--from", "old.sqlite"]) ?? "";
	assert.match(refusal, /batch step a person runs/);
	assert.doesNotMatch(refusal, /gap in this package/);
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
		addFlags(["annotations"], { bill: "119-hr-1", all: false, paths: ["a", "b"], limit: 5 }, spec),
		["annotations", "--bill", "119-hr-1", "--path", "a", "--path", "b", "--limit", "5"],
	);
	assert.deepEqual(addFlags(["annotations"], { bill: "", all: false, paths: [], limit: undefined }, spec), ["annotations"]);
});

// words_to_data refuses --all with --limit (exit 2), and the model sent both in two
// runs of 2026-10-26 (w2d_search, w2d_opinions). Every row is what all asks for.
test("addFlags leaves out --limit when all is set", () => {
	const spec = { all: { flag: "--all", kind: "flag" as const }, limit: { flag: "--limit" } };
	assert.deepEqual(addFlags(["opinions"], { all: true, limit: 5 }, spec), ["opinions", "--all"]);
	assert.deepEqual(addFlags(["opinions"], { all: false, limit: 5 }, spec), ["opinions", "--limit", "5"]);
});

// words-to-data #355 and #356 put a places[] list with seven dates and states on each
// citation. The pretty JSON of cases-citing for 26 U.S.C. § 174 on the eval dataset grew
// to 49,463 characters, past the 40,000 a JSON answer may hold, so the model got JSON it
// could not parse. Without the indentation it is 28,491.
test("compactJson drops the white space of pretty JSON and keeps everything else", () => {
	const pretty = JSON.stringify({ places: [{ citation_text: "26 U. S. C. § 174", written: ["174(a)(1)"], time_basis: null }] }, null, 2);
	const compact = compactJson(pretty);
	assert.equal(compact, '{"places":[{"citation_text":"26 U. S. C. § 174","written":["174(a)(1)"],"time_basis":null}]}');
	assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));
	// Output that is not JSON (a notice, an error text) goes through unchanged.
	assert.equal(compactJson("No opinion cites it.\n"), "No opinion cites it.\n");
});

// sleuth-pi #23: in a --write hunt run, the first w2d_link_amendment call had the
// reason "placeholder". A write reason must quote the amendment's own words.
const AMENDMENT =
	'(d) Conforming Amendment.—Section 24(h)(5) is amended to read as follows:"(5) Applicability.Maximum amount of refundable credit.—The amount determined under subsection (d)(1)(A) with respect to any qualifying child shall not exceed $1,400".';

test("a placeholder reason is refused by name, and the refusal says what to do (#23)", () => {
	for (const reason of ["placeholder", "Placeholder.", "TODO", "tbd", "reason", "x", "", "   ", "N/A", undefined]) {
		const refusal = placeholderReasonError(reason, "Quote the amendment.");
		assert.match(refusal ?? "", /is a placeholder, so nothing was recorded\. Quote the amendment\.$/, String(reason));
	}
	assert.match(placeholderReasonError("amends section 24", "Quote it.") ?? "", /has 3 word\(s\), too few/);
	assert.equal(placeholderReasonError("The bill says the credit shall not exceed $1,400.", "Quote it."), undefined);
});

test("quote marks, dashes, case and line breaks do not count in a quote (#23)", () => {
	assert.deepEqual(quoteWords("“Amount—determined” under\nsubsection (d)(1)(A)"), ["amount", "determined", "under", "subsection", "d", "1", "a"]);
	// Curly quotes and a different dash in the reason, a line break in the source.
	assert.ok(quotesSource('It says "Conforming Amendment-Section 24(h)(5) is amended" and the heading changed.', AMENDMENT));
	assert.ok(quotesSource("with respect to any qualifying\nchild", AMENDMENT));
	assert.ok(!quotesSource("with respect to any child", AMENDMENT), "the words must be consecutive");
	assert.ok(!quotesSource("is amended to read", AMENDMENT), "4 words are not enough");
	assert.ok(!quotesSource("The amendment changed the credit for each qualifying child.", AMENDMENT));
});

test("a source shorter than the run must be quoted whole; an empty source matches nothing (#23)", () => {
	assert.ok(quotesSource('The law says: by striking "2025".', 'by striking "2025"'));
	assert.ok(!quotesSource("It strikes 2025 and inserts 2026.", "by striking 2025"));
	assert.ok(!quotesSource("five words of no source", ""));
});

test("a reason with no quote of the source is refused with the way to fix it (#23)", () => {
	assert.equal(unquotedReasonError("The bill now says the amount shall not exceed $1,400.", AMENDMENT, "Quote it."), undefined);
	assert.match(
		unquotedReasonError("The amendment rewrote the paragraph about the refundable credit.", AMENDMENT, "Quote it.") ?? "",
		/quotes no run of 5 consecutive words of the evidence, so nothing was recorded\. Quote it\.$/,
	);
});
