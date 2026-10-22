/**
 * Loads the extensions the way pi does and checks the tools it registers.
 *
 * The schema checks exist because a flag descriptor ({ flag, kind }, what
 * addFlags consumes) once got spread into a Type.Object instead of the parameter
 * schema. pi read the descriptor as a schema, so the property came out required
 * with no type, and a call omitting it was rejected before execute ran. Nothing
 * else noticed: the tool still registered, and every other tool looked fine.
 *
 * The dataset checks run only when a dataset and the words_to_data binary are
 * configured, so CI skips them. Set W2D_DATASET and W2D_BIN to run them.
 * Against a full dataset they take a couple of minutes: `validate` and
 * `redesignation-report` are slow commands. The gap ledger needs no
 * words_to_data: its test runs against a small SQLite file it makes itself.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { validateToolArguments } from "@earendil-works/pi-ai";

import w2d from "../extensions/w2d.ts";
import w2dGuard from "../extensions/w2d-guard.ts";
import w2dSql from "../extensions/w2d-sql.ts";
import { getDatasetPath, rawCommandError, setBinaryPath, setDatasetPath } from "../src/w2d-common.ts";

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	promptGuidelines?: string[];
	parameters: Record<string, unknown>;
	execute?: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function loadExtensions(): { tools: Map<string, RegisteredTool>; commands: Set<string> } {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Set<string>();
	for (const extension of [w2d, w2dGuard, w2dSql]) {
		extension({
			registerTool: (tool: RegisteredTool) => {
				// pi keeps one tool per name; a collision would silently shadow one of them.
				assert.ok(!tools.has(tool.name), `tool registered twice: ${tool.name}`);
				tools.set(tool.name, tool);
			},
			registerCommand: (name: string) => commands.add(name),
			on: () => {},
			appendEntry: () => {},
		} as never);
	}
	return { tools, commands };
}

test("registers every tool, command and prompt hook", () => {
	const { tools, commands } = loadExtensions();
	assert.ok(tools.size >= 26, `expected at least 26 tools, got ${tools.size}`);
	for (const name of [
		"w2d_dataset",
		"w2d_info",
		"w2d_expressions",
		"w2d_bills",
		"w2d_opinions",
		"w2d_validate",
		"w2d_search",
		"w2d_diff",
		"w2d_path",
		"w2d_annotations",
		"w2d_residue",
		"w2d_coverage",
		"w2d_contradictions",
		"w2d_cases_citing",
		"w2d_release_points",
		"w2d_section_agreement",
		"w2d_amendment_addresses",
		"w2d_redesignation_report",
		"w2d_show_bill",
		"w2d_votes",
		"w2d_settle",
		"w2d_link_amendment",
		"w2d_fetch",
		"w2d_raw",
		"w2d_gap_record",
		"w2d_sql",
	]) {
		assert.ok(tools.has(name), `missing tool ${name}`);
	}
	assert.ok(commands.has("dataset"), "missing the /dataset command");
});

test("every tool schema is a schema, not a flag descriptor", () => {
	const { tools } = loadExtensions();
	for (const [name, tool] of tools) {
		assert.ok(tool.label.length > 0, `${name} has no label`);
		assert.ok(tool.description.length > 40, `${name} has no real description`);
		const schema = tool.parameters as { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[] };
		assert.equal(schema.type, "object", `${name} parameters is not an object schema`);
		const properties = schema.properties ?? {};
		assert.ok(Object.keys(properties).length > 0 || name === "w2d_validate", `${name} takes no parameters at all`);
		for (const [property, spec] of Object.entries(properties)) {
			assert.ok(
				!spec || !("flag" in spec),
				`${name}.${property} is an addFlags descriptor ({ flag: ${(spec as { flag?: unknown }).flag} }) used as a parameter schema; it would read as a required property with no type`,
			);
			const typed = spec && (typeof spec.type === "string" || Array.isArray(spec.type) || spec.anyOf || spec.enum || spec.$ref);
			assert.ok(typed, `${name}.${property} has no type, anyOf or enum, so pi cannot validate it`);
		}
		for (const required of schema.required ?? []) {
			assert.ok(Object.hasOwn(properties, required), `${name} requires ${required}, which is not in its properties`);
		}
	}
});

test("tool descriptions match the commands they wrap", () => {
	const { tools } = loadExtensions();
	const property = (tool: string, name: string) =>
		((tools.get(tool)!.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {})[name];
	// The command counts characters (--snippet <CHARS>); "words" made the model ask for far too little.
	assert.match(property("w2d_search", "snippet")?.description ?? "", /[Cc]haracters/);
	assert.doesNotMatch(property("w2d_search", "snippet")?.description ?? "", /words/);
	// cases-citing has --json since words-to-data #303.
	assert.ok(property("w2d_cases_citing", "json"), "w2d_cases_citing has no json parameter");
	assert.doesNotMatch(tools.get("w2d_cases_citing")!.description, /No --json/);
	// The rule against guessed paths and ids goes into the system prompt with the path tool.
	const guidelines = (tools.get("w2d_path")!.promptGuidelines ?? []).join("\n");
	assert.match(guidelines, /from w2d_\* tool output/);
	assert.match(guidelines, /Check a path with w2d_path/);
	// Since words-to-data #305 a path no expression holds gets a notice with the nearest held path.
	assert.match(guidelines, /nearest held path/);
	assert.match(guidelines, /w2d_cases_citing as cites/);
	// Since words-to-data #306 search counts fields and occurrences, and reads a window at an offset.
	assert.ok(property("w2d_search", "occurrences"), "w2d_search has no occurrences parameter");
	assert.ok(property("w2d_search", "offset"), "w2d_search has no offset parameter");
	const search = tools.get("w2d_search")!.description;
	assert.match(search, /occurrences/);
	assert.match(search, /offset/);
	assert.doesNotMatch(search, /a hit count is not a count of mentions/);
	// opinions (#308) names each writing and its author.
	assert.match(tools.get("w2d_opinions")!.description, /author/);
	assert.match(tools.get("w2d_raw")!.description, /opinions/);
	// Case structure (words-to-data #313, #327, #314): a case is a work, each writing a path under it, with pages.
	for (const name of ["w2d_opinions", "w2d_path", "w2d_search", "w2d_fetch"]) {
		assert.match(tools.get(name)!.description, /judicial\/case_<cluster>\/opinion_<id>/, `${name} does not name the writing path`);
	}
	for (const name of [...tools.keys()]) {
		assert.doesNotMatch(tools.get(name)!.description, /judicial\/opinion_<id>|a court opinion is one field/, `${name} still names the old opinion work`);
	}
	assert.match(tools.get("w2d_path")!.description, /pages and footnotes/);
	assert.match(tools.get("w2d_search")!.description, /page_459/);
	assert.match(guidelines, /pin cite/);
});

test("pi validates the new search parameters and refuses work@date for at", () => {
	const { tools } = loadExtensions();
	const check = (name: string, args: Record<string, unknown>) =>
		validateToolArguments(tools.get(name) as never, { type: "toolCall", id: "x", name, arguments: args } as never);
	assert.doesNotThrow(() => check("w2d_search", { query: "174", path: "judicial/case_122262/opinion_9434364", occurrences: true }));
	assert.doesNotThrow(() => check("w2d_search", { query: "", path: "judicial/case_122262/opinion_9434364/page_454/paragraph_3", exact: true, offset: 268, snippet: 2000 }));
	assert.doesNotThrow(() => check("w2d_search", { query: "credit", at: "2025-07-18" }));
	// search --at takes a date alone since #305; the schema says so before the CLI does.
	assert.throws(() => check("w2d_search", { query: "credit", at: "uscode/title_26@2025-07-18" }));
	assert.throws(() => check("w2d_search", { query: "credit", offset: -1 }));
	assert.doesNotThrow(() => check("w2d_opinions", {}));
	assert.doesNotThrow(() => check("w2d_opinions", { all: true, json: true }));
});

test("w2d_raw refuses writers and allows read-only commands", () => {
	assert.match(rawCommandError("link-amendment", []) ?? "", /does not write/);
	assert.match(rawCommandError("settle", ["--verdict", "confirmed"]) ?? "", /does not write/);
	assert.equal(rawCommandError("settle", ["--explain"]), undefined);
	assert.match(rawCommandError("frobnicate", []) ?? "", /does not know the subcommand/);
	// release-points takes no dataset, so raw would pass it a wrong argument.
	assert.match(rawCommandError("release-points", []) ?? "", /use w2d_release_points/);
	assert.equal(rawCommandError("opinions", ["--all"]), undefined);
});

test("w2d_gap_record accepts any query of the session and keeps an unbacked gap with a note", async () => {
	// A small dataset of its own: the ledger needs SQLite, not words_to_data.
	const db = join(mkdtempSync(join(tmpdir(), "sleuth-gap-")), "gap.sqlite");
	const setup = new DatabaseSync(db);
	setup.exec("CREATE TABLE sponsors (bill_id TEXT, data_json TEXT); INSERT INTO sponsors VALUES ('119-hr-1', '{}');");
	setup.close();
	setDatasetPath(db);
	const { tools } = loadExtensions();
	const ctx = { cwd: process.cwd() };
	const call = async (name: string, params: Record<string, unknown>) => {
		const result = await tools.get(name)!.execute!("x", params, undefined, undefined, ctx);
		assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
		return result.content[0]?.text ?? "";
	};
	const gap = (sql: string) => ({ question: "Who sponsored 119-hr-1?", sql, missingCommand: "words_to_data sponsors" });

	const first = "SELECT bill_id FROM sponsors WHERE bill_id = '119-hr-1'";
	assert.match(await call("w2d_sql", { sql: `${first};` }), /rowCount/);
	assert.match(await call("w2d_sql", { sql: "SELECT COUNT(*) AS n FROM sponsors" }), /rowCount/);
	// Not the last query, other white space, a trailing semicolon: still the query that ran.
	const backed = await call("w2d_gap_record", gap(`SELECT bill_id\n  FROM sponsors\tWHERE bill_id = '119-hr-1' ;`));
	assert.match(backed, /^Gap recorded\. Gaps this session:\n1\. Who sponsored 119-hr-1\?/);
	assert.doesNotMatch(backed, /note:/);

	// A query that never ran is kept, not refused, and the note says it is not backed.
	const unbacked = await call("w2d_gap_record", gap("SELECT data_json FROM sponsors"));
	assert.match(unbacked, /^Gap recorded, with a note: not backed by a query/);
	assert.match(unbacked, /2\. Who sponsored 119-hr-1\?[^]*note: not backed by a query/);
});

const dataset = (() => {
	try {
		return getDatasetPath();
	} catch {
		return undefined;
	}
})();
const binary = process.env.W2D_BIN ?? "";
const runnable = !!dataset && !!binary && existsSync(binary);

test("the tools answer against a real dataset", { skip: runnable ? false : "set W2D_DATASET and W2D_BIN" }, async () => {
	setBinaryPath(binary);
	setDatasetPath(dataset!);
	const { tools } = loadExtensions();
	const ctx = { cwd: process.cwd() };
	const call = async (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name);
		assert.ok(tool, `missing tool ${name}`);
		const result = await tool!.execute!("x", params, undefined, undefined, ctx);
		assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
		return result.content[0]?.text ?? "";
	};

	assert.match(await call("w2d_dataset", {}), /Dataset in force/);
	assert.match(await call("w2d_info", {}), /Name:|Dataset:/);
	assert.match(await call("w2d_expressions", {}), /^EXPRESSION\s+ELEMENTS\s+LABEL/);
	assert.match(await call("w2d_validate", {}), /.+/);

	// A window from the dataset itself, so the assertions hold for any dataset. The
	// table output, not --json: bounded output can truncate a large JSON array.
	const byWork = new Map<string, { expression: string; elements: number }[]>();
	for (const line of (await call("w2d_expressions", {})).split("\n")) {
		const [expression, elements] = line.trim().split(/\s+/);
		const at = expression?.lastIndexOf("@") ?? -1;
		if (at <= 0) continue;
		const work = expression!.slice(0, at);
		byWork.set(work, [...(byWork.get(work) ?? []), { expression: expression!, elements: Number(elements) || 0 }]);
	}
	// The smallest work with two expressions: data-driven so any dataset works, and
	// small enough that the CLI calls stay quick.
	const window = [...byWork.values()]
		.filter((rows) => rows.length >= 2)
		.sort((a, b) => Math.max(...a.map((r) => r.elements)) - Math.max(...b.map((r) => r.elements)))[0]
		?.map((r) => r.expression)
		.sort();
	if (window) {
		const from = window[0]!;
		const to = window[window.length - 1]!;
		assert.match(await call("w2d_coverage", { from, to }), /changed paths/);
		assert.match(await call("w2d_section_agreement", { from, to }), /link|no amendment link/);
		// The window is echoed whether or not anything changed, so this holds for any dataset.
		const diff = await call("w2d_diff", { from, to });
		assert.ok(diff.includes(" -> "), `w2d_diff did not echo the window: ${diff.slice(0, 200)}`);
	} else {
		console.warn("no work with two expressions: skipped coverage, section-agreement and diff");
	}

	assert.match(await call("w2d_cases_citing", { cites: "26 U.S.C. § 174" }), /opinions? in the dataset|cites it|No opinion/);
	assert.match(await call("w2d_redesignation_report", {}), /Statements:/);

	// Since words-to-data #303 the JSON is one entry per path asked about; #313 renamed opinions_held to cases_held.
	const citing = JSON.parse(await call("w2d_cases_citing", { cites: "26 U.S.C. § 174", json: true })) as { path: string; cases_held: number }[];
	assert.ok(Array.isArray(citing) && citing.length > 0, "cases-citing --json is not a list of paths");
	assert.match(citing[0]!.path, /section_174/);
	assert.equal(typeof citing[0]!.cases_held, "number");

	// opinions (#308, #313): a count line, whether the dataset holds opinions or not.
	assert.match(await call("w2d_opinions", {}), /This dataset holds \d+ writings? in \d+ cases?/);
	const opinions = JSON.parse(await call("w2d_opinions", { json: true })) as { opinions: { case: string; path: string }[] };
	assert.ok(Array.isArray(opinions.opinions), "opinions --json has no opinions list");
	// path on a case and on a writing (#327, #314): the facts under judicial, what is inside under contents.
	const writing = opinions.opinions[0];
	if (writing) {
		assert.match(writing.path, /^judicial\/case_\d+\/opinion_\d+$/);
		assert.equal(writing.case, writing.path.replace(/\/opinion_\d+$/, ""));
		const onCase = JSON.parse(await call("w2d_path", { path: writing.case, json: true })) as { judicial?: unknown };
		assert.ok(onCase.judicial, "path on a case has no judicial facts");
		const onWriting = JSON.parse(await call("w2d_path", { path: writing.path, json: true })) as { judicial?: unknown; contents?: unknown[] };
		assert.ok(onWriting.judicial, "path on a writing has no judicial facts");
		assert.ok(Array.isArray(onWriting.contents), "path on a writing has no contents");
	} else {
		console.warn("the dataset holds no opinions: skipped path on a case and a writing");
	}

	// search --occurrences (#306): every occurrence has an offset, and offset reads a window there.
	const titled = [...byWork.keys()].find((work) => work.startsWith("uscode/")) ?? [...byWork.keys()][0]!;
	const found = JSON.parse(await call("w2d_search", { query: "section", work: titled, occurrences: true, limit: 3, json: true })) as {
		hits: { path: string; field: string; offset: number; expression: { at: string } }[];
		total: number;
	};
	assert.ok(found.hits.length > 0, `no occurrence of "section" in ${titled}`);
	for (const hit of found.hits) assert.equal(typeof hit.offset, "number", "an occurrence has no offset");
	assert.match(await call("w2d_search", { query: "section", work: titled, limit: 3 }), /\d+ fields?, \d+ occurrences?/);
	assert.match(await call("w2d_search", { query: "section", work: titled, occurrences: true, limit: 3 }), /\] at \d+\n[^]*\d+ occurrences?/);
	const first = found.hits[0]!;
	const around = await call("w2d_search", { query: "", work: titled, at: first.expression.at, path: first.path, exact: true, offset: first.offset, snippet: 40 });
	assert.match(around, /section/i, "the window at the offset does not hold the word found there");

	// A guessed path (#305): a notice and the nearest held path, not a bare empty result.
	assert.match(await call("w2d_search", { query: "section", work: titled, path: `${titled}/section_0000zz` }), /Nearest held path: /);

	// Offline, so the test never reaches the mirror; it reads no dataset.
	assert.match(await call("w2d_release_points", { offline: true }), /release point|cache/i);
});
