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
 * configured, so CI skips them. Set W2D_DATASET and W2D_BIN to run them, and
 * W2D_ALLOW_WRITE=1 to also test recording a gap (it writes to a copy of the
 * dataset, never the dataset itself). Against a full dataset they take a couple
 * of minutes: `validate` and `redesignation-report` are slow commands.
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import w2d from "../extensions/w2d.ts";
import w2dGuard from "../extensions/w2d-guard.ts";
import w2dSql from "../extensions/w2d-sql.ts";
import { getDatasetPath, rawCommandError, setBinaryPath, setDatasetPath } from "../src/w2d-common.ts";

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
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
	assert.ok(tools.size >= 24, `expected at least 24 tools, got ${tools.size}`);
	for (const name of [
		"w2d_dataset",
		"w2d_info",
		"w2d_expressions",
		"w2d_bills",
		"w2d_validate",
		"w2d_search",
		"w2d_diff",
		"w2d_path",
		"w2d_annotations",
		"w2d_residue",
		"w2d_coverage",
		"w2d_contradictions",
		"w2d_cases_citing",
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

test("w2d_raw refuses writers and allows read-only commands", () => {
	assert.match(rawCommandError("link-amendment", []) ?? "", /does not write/);
	assert.match(rawCommandError("settle", ["--verdict", "confirmed"]) ?? "", /does not write/);
	assert.equal(rawCommandError("settle", ["--explain"]), undefined);
	assert.match(rawCommandError("frobnicate", []) ?? "", /does not know the subcommand/);
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

	// A gap is only real if its SQL ran immediately before, so recording one without
	// the query is refused. The refusal writes nothing, so it is safe to try here.
	const gap = { question: "Who sponsored the bill?", sql: "SELECT COUNT(*) AS links FROM links", missingCommand: "w2d_sponsors" };
	const refused = await tools.get("w2d_gap_record")!.execute!("x", gap, undefined, undefined, ctx);
	assert.ok(refused.isError, "a gap recorded without running its query first must be refused");

	// Recording one does write, so it needs an explicit opt-in and runs against a copy:
	// the dataset under test is never modified. The guard ties the record to the dataset
	// the query ran against, so both happen on the copy.
	if (process.env.W2D_ALLOW_WRITE !== "1") {
		console.warn("skipped recording a gap (set W2D_ALLOW_WRITE=1; it writes to a copy of the dataset)");
		return;
	}
	const copy = join(mkdtempSync(join(tmpdir(), "sleuth-tools-")), "dataset.sqlite");
	copyFileSync(dataset!, copy);
	setDatasetPath(copy);
	assert.match(await call("w2d_sql", { sql: gap.sql }), /rowCount/);
	assert.match(await call("w2d_gap_record", gap), /Gap recorded\. Gaps this session:\n1\. Who sponsored the bill\?/);
});
