/**
 * Read-only SQLite peek into a words_to_data dataset.
 *
 * The playbook says the commands are the contract: try a w2d_* tool first.
 * When no command can answer the question, this tool may read the database
 * directly — and the question MUST be recorded as a tool gap with
 * w2d_gap_record, so the missing command becomes an issue for words-to-data.
 */

import { type ChildProcess, spawn } from "node:child_process";

// Type comes from pi-ai, not typebox, so schemas are built with the TypeBox copy
// that validates them. See the note in w2d.ts.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getDatasetPath, normalizeSql, sqlReadError, W2dError } from "../src/w2d-common.ts";

const MAX_ROWS = 500;
const MAX_CELL = 2000;
// The local model has a 262,144-token context, but 500 short rows still fill a
// large part of it, so the text has a limit of its own.
const MAX_TEXT = 30_000;

// sleuth-pi #21: one query held pi for more than 32 minutes. A DatabaseSync call
// blocks the event loop, and Node 22's node:sqlite has no interrupt or progress
// handler, so a timer in this process cannot stop it, and pi did not even stop
// on SIGTERM. Each query runs in a child process, which is killed at the limit.
const DEFAULT_TIMEOUT_S = 60;

/** The time limit of one query, in seconds: SLEUTH_SQL_TIMEOUT_S, or 60. */
export function sqlTimeoutSeconds(): number {
	const value = Number(process.env.SLEUTH_SQL_TIMEOUT_S);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_S;
}

// The child: read the query on stdin, run it on a read-only connection, and
// write at most MAX_ROWS rows and the full row count as JSON on stdout.
const CHILD = `
const { DatabaseSync } = require("node:sqlite");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
	let out;
	try {
		const { dataset, sql, params, maxRows, maxCell } = JSON.parse(input);
		const db = new DatabaseSync(dataset, { readOnly: true });
		try {
			const rows = [];
			let rowCount = 0;
			for (const row of db.prepare(sql).iterate(...params)) {
				rowCount++;
				if (rows.length < maxRows) {
					rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) =>
						[k, typeof v === "string" && v.length > maxCell ? v.slice(0, maxCell) + "\u2026[truncated]" : v])));
				}
			}
			out = { ok: true, rowCount, rows };
		} finally {
			db.close();
		}
	} catch (err) {
		out = { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	process.stdout.write(JSON.stringify(out));
});
`;

type QueryResult =
	| { kind: "rows"; rowCount: number; rows: Record<string, unknown>[] }
	| { kind: "error"; message: string }
	| { kind: "timeout" }
	| { kind: "aborted" };

// A query still running when pi exits must not live on without it.
const running = new Set<ChildProcess>();
let exitHook = false;

function runQuery(dataset: string, sql: string, params: (string | number)[], timeoutS: number, signal: AbortSignal | undefined): Promise<QueryResult> {
	if (!exitHook) {
		exitHook = true;
		process.once("exit", () => {
			for (const child of running) child.kill("SIGKILL");
		});
	}
	// pi runs on Node; a Bun build of pi would run itself, so it takes node from PATH.
	const node = process.versions.bun ? "node" : process.execPath;
	return new Promise((resolve) => {
		const child = spawn(node, ["--no-warnings", "-e", CHILD], { stdio: ["pipe", "pipe", "pipe"] });
		running.add(child);
		let stdout = "";
		let stderr = "";
		let stopped: "timeout" | "aborted" | undefined;
		const stop = (why: "timeout" | "aborted") => {
			stopped ??= why;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop("timeout"), timeoutS * 1000);
		const onAbort = () => stop("aborted");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8").on("data", (c: string) => {
			stdout += c;
		});
		child.stderr.setEncoding("utf8").on("data", (c: string) => {
			stderr += c;
		});
		const finish = (result: QueryResult) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			running.delete(child);
			resolve(result);
		};
		child.on("error", (err) => finish({ kind: "error", message: `Could not start the query process (${node}): ${err.message}` }));
		child.on("close", (code) => {
			if (stopped) return finish({ kind: stopped });
			try {
				const out = JSON.parse(stdout) as { ok: true; rowCount: number; rows: Record<string, unknown>[] } | { ok: false; error: string };
				finish(out.ok ? { kind: "rows", rowCount: out.rowCount, rows: out.rows } : { kind: "error", message: out.error });
			} catch {
				finish({ kind: "error", message: `The query process stopped (exit ${code}) with no result.${stderr ? ` ${stderr.trim().slice(0, 500)}` : ""}` });
			}
		});
		child.stdin.on("error", () => {}); // the child can exit before it reads all of stdin
		child.stdin.end(JSON.stringify({ dataset, sql, params, maxRows: MAX_ROWS, maxCell: MAX_CELL }));
	});
}

function fail(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "w2d_sql",
		label: "W2D SQL (read-only)",
		description:
			`Run one read-only SELECT against the registered dataset with Node's built-in SQLite. POLICY: the words_to_data commands are the contract — use a w2d_* tool first, then w2d_raw for a read-only command with no tool of its own; a peek is only for questions no command answers at all, and every peek must be followed by w2d_gap_record (question, the SQL, the command the tool should have offered). Reads only: one SELECT / WITH / EXPLAIN / VALUES statement, or a schema PRAGMA such as PRAGMA table_info(links); read-only functions such as replace(), substr() and json_extract() are fine. The dataset is opened read-only. Each query stops after ${sqlTimeoutSeconds()} s, so filter on an indexed column and add LIMIT. Schema (verify with: SELECT name FROM sqlite_master WHERE type = 'table'; SELECT name FROM pragma_table_info('<table>')): expressions(work, date, label, element_json); element_index(work, date, path, node_type, heading, chapeau, content, proviso, continuation, ordinal); links(id, kind, subject_tag, subject_json, object_tag, object_json, provenance_json, payload_json, subject_work, subject_path, subject_from_date, subject_to_date, object_reference) — the link's source (rule:evidence_matching, agent:<name>, human:<name>) is inside provenance_json, not a column; subject_work is NULL for judicial.cites and olrc.classified_from, and object_reference is NULL for judicial.cites and legislature.redesignated_as; bills(bill_id, data_json); sponsors(bill_id, data_json); members(bioguide_id, data_json); roll_calls(id, bill_id, congress, session, roll_number, date, question, result, yea_count, nay_count, not_voting_count, present_count); member_votes(roll_call_id, bioguide_id, position); model_replies(id, reply); metadata(key, value).`,
		parameters: Type.Object({
			sql: Type.String({ description: "A single SELECT / WITH / EXPLAIN / VALUES statement, or a schema PRAGMA" }),
			params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]), { description: "Bound parameters for ? placeholders" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sql = params.sql.trim().replace(/;\s*$/, "");
			const refused = sqlReadError(sql);
			if (refused) return fail(refused);
			let dataset: string;
			try {
				dataset = getDatasetPath(ctx.cwd); // must be a real registered dataset before peeking
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
			const timeoutS = sqlTimeoutSeconds();
			const result = await runQuery(dataset, sql, params.params ?? [], timeoutS, signal);
			if (result.kind === "timeout") {
				return fail(
					`Query stopped after ${timeoutS} s (the time limit of one w2d_sql query). Make it smaller: filter on an indexed column (element_index by work and date, links by kind or subject_work), add LIMIT, or count instead of joining whole tables. A FULL OUTER JOIN over element_index is too slow.`,
				);
			}
			if (result.kind === "aborted") return fail("Query stopped: the call was cancelled.");
			if (result.kind === "error") return fail(result.message);
			recordSqlRun({ sql: normalizeSql(sql), dataset });
			const payload = { rowCount: result.rowCount, returned: result.rows.length, rows: result.rows };
			const text = JSON.stringify(payload, null, 1);
			if (result.rowCount > MAX_ROWS || text.length > MAX_TEXT) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${text.slice(0, MAX_TEXT)}\n[Truncated at ${MAX_TEXT} characters; the query returned ${result.rowCount} rows. Add LIMIT, select fewer columns, or aggregate (COUNT, GROUP BY).]`,
						},
					],
					details: undefined,
				};
			}
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// Gap ledger: persisted as session entries so the end-of-run report can
	// list every question that forced a SQL peek, and any SQL finding survives
	// compaction.
	interface GapEntry {
		question: string;
		sql: string;
		missingCommand: string;
		at: string;
		/** Set when the SQL does not match a w2d_sql call of this session. */
		note?: string;
	}
	let gaps: GapEntry[] = [];
	// Every successful w2d_sql of the session, normalized, kept in the shared
	// globalThis slot for the same reason as the dataset path (pi loads each
	// extension file separately). A gap is checked against all of them: an agent
	// often runs several queries, or retypes one, before it records the gap.
	const sqlKey = "__sleuthPiSqlRuns";
	interface SqlRun {
		sql: string;
		dataset: string;
	}
	const sqlRuns = (): SqlRun[] => {
		const g = globalThis as Record<string, unknown>;
		if (!Array.isArray(g[sqlKey])) g[sqlKey] = [];
		return g[sqlKey] as SqlRun[];
	};
	const recordSqlRun = (run: SqlRun) => {
		const runs = sqlRuns();
		runs.push(run);
		if (runs.length > 500) runs.splice(0, runs.length - 500);
	};
	const format = (g: GapEntry, i: number) =>
		`${i + 1}. ${g.question}\n   sql: ${g.sql}\n   missing: ${g.missingCommand}${g.note ? `\n   note: ${g.note}` : ""}`;

	const reconstruct = (ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		gaps = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type?: string; customType?: string; data?: GapEntry };
			if (e.type === "entry" && e.customType === "sleuth.gap" && e.data) gaps.push(e.data);
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		(globalThis as Record<string, unknown>)[sqlKey] = [];
		reconstruct(ctx as never);
	});
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx as never));

	pi.registerTool({
		name: "w2d_gap_record",
		label: "W2D gap record",
		description:
			"Record a words-to-data gap: a question no command could answer that you had to answer with w2d_sql. Every w2d_sql peek must be followed by one of these. Give the SQL of any w2d_sql call of this session (white space and a trailing semicolon do not matter). A gap whose SQL matches no call is recorded with a note that it is not backed by a query. The session's report ends with the gap list so it can be filed against words-to-data.",
		parameters: Type.Object({
			question: Type.String({ description: "The question the commands could not answer" }),
			sql: Type.String({ description: "The SQL that answered it, as you ran it with w2d_sql" }),
			missingCommand: Type.String({ description: "The command or flag words_to_data should offer instead" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// A gap is a finding about the commands, so it must be backed by a query
			// that really ran against the registered dataset. A gap that is not is
			// still kept, with a note, so the finding is not lost to a typo.
			let dataset: string;
			try {
				dataset = getDatasetPath(ctx.cwd);
			} catch (err) {
				return fail(err instanceof W2dError ? err.message : String(err));
			}
			const sql = normalizeSql(params.sql);
			const runs = sqlRuns().filter((r) => r.sql === sql);
			let note: string | undefined;
			if (runs.length === 0) {
				note = "not backed by a query: this SQL matches no w2d_sql call of this session";
			} else if (!runs.some((r) => r.dataset === dataset)) {
				note = `the query ran against ${runs[runs.length - 1]!.dataset}, not the dataset in force (${dataset})`;
			}
			const entry: GapEntry = { ...params, at: new Date().toISOString(), ...(note ? { note } : {}) };
			gaps.push(entry);
			pi.appendEntry("sleuth.gap", entry);
			const remaining = gaps.map(format).join("\n");
			const head = note ? `Gap recorded, with a note: ${note}.` : "Gap recorded.";
			return { content: [{ type: "text" as const, text: `${head} Gaps this session:\n${remaining}` }], details: undefined };
		},
	});

	pi.registerCommand("sleuth-gaps", {
		description: "List words-to-data gaps recorded this session (for the end-of-run report)",
		handler: async (_args, ctx) => {
			reconstruct(ctx as never);
			if (gaps.length === 0) {
				ctx.ui.notify("No gaps recorded this session.", "info");
				return;
			}
			const lines = gaps.map(format).join("\n\n");
			ctx.ui.notify(`Gaps this session:\n\n${lines}`, "info");
		},
	});
}
