/**
 * Read-only SQLite peek into a words_to_data dataset.
 *
 * The playbook says the commands are the contract: try a w2d_* tool first.
 * When no command can answer the question, this tool may read the database
 * directly — and the question MUST be recorded as a tool gap with
 * w2d_gap_record, so the missing command becomes an issue for words-to-data.
 */

import { DatabaseSync } from "node:sqlite";
// Type comes from pi-ai, not typebox, so schemas are built with the TypeBox copy
// that validates them. See the note in w2d.ts.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getDatasetPath, W2dError } from "../src/w2d-common.ts";

const MAX_ROWS = 500;
const MAX_CELL = 2000;

const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|replace)\b/i;

function fail(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "w2d_sql",
		label: "W2D SQL (read-only)",
		description:
			"Run one read-only SELECT against the registered dataset with Node's built-in SQLite. POLICY: the words_to_data commands are the contract — use a w2d_* tool first, then w2d_raw for a read-only command with no tool of its own; a peek is only for questions no command answers at all, and every peek must be followed by w2d_gap_record (question, the SQL, the command the tool should have offered). Reads only: SELECT/WITH/EXPLAIN, single statement. Schema (verify with: SELECT name FROM sqlite_master; PRAGMA table_info(<table>)): expressions(work, date, label, element_json); element_index(work, date, path, node_type, heading, chapeau, content, proviso, continuation, ordinal); links(id, kind, subject_tag, subject_json, object_tag, object_json, provenance_json, payload_json, subject_work, subject_path, subject_from_date, subject_to_date, object_reference) — the link's source (rule:evidence_matching, agent:<name>, human:<name>) is inside provenance_json, not a column; bills(bill_id, data_json); sponsors(bill_id, data_json); members(bioguide_id, data_json); roll_calls(id, bill_id, congress, session, roll_number, date, question, result, yea_count, nay_count, not_voting_count, present_count); member_votes(roll_call_id, bioguide_id, position); model_replies(id, reply); metadata(key, value).",
		parameters: Type.Object({
			sql: Type.String({ description: "A single SELECT / WITH / EXPLAIN statement" }),
			params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]), { description: "Bound parameters for ? placeholders" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sql = params.sql.trim().replace(/;\s*$/, "");
			if (/;/.test(sql)) return fail("Only one statement per call.");
			if (!/^(select|with|explain)\b/i.test(sql)) return fail("Only SELECT / WITH / EXPLAIN statements are allowed. The dataset is opened read-only; make a read a gap finding with w2d_gap_record instead of writing.");
			if (WRITE_KEYWORDS.test(sql)) return fail(`Statement contains a write keyword and was rejected: ${WRITE_KEYWORDS.exec(sql)?.[0]}`);
			let db: DatabaseSync | undefined;
			try {
				const dataset = getDatasetPath(ctx.cwd); // must be a real registered dataset before peeking
				db = new DatabaseSync(dataset, { readOnly: true });
				const rows = db.prepare(sql).all(...(params.params ?? [])) as Record<string, unknown>[];
				const truncatedRows = rows.slice(0, MAX_ROWS);
				const cells = (row: Record<string, unknown>) =>
					Object.fromEntries(
						Object.entries(row).map(([k, v]) => [k, typeof v === "string" && v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…[truncated]` : v]),
					);
				setLastSql({ sql, at: Date.now(), dataset });
				const payload = {
					rowCount: rows.length,
					returned: truncatedRows.length,
					rows: truncatedRows.map(cells),
				};
				const text = JSON.stringify(payload, null, 1);
				if (rows.length > MAX_ROWS) {
					return {
						content: [{ type: "text" as const, text: `${text.slice(0, 30000)}\n[${rows.length - MAX_ROWS} rows not shown. Add LIMIT.]` }],
						details: undefined,
					};
				}
				return { content: [{ type: "text" as const, text }], details: undefined };
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			} finally {
				db?.close();
			}
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
	}
	let gaps: GapEntry[] = [];
	// Last successful w2d_sql, kept in the shared globalThis slot for the same
	// reason as the dataset path (pi loads each extension file separately).
	const sqlKey = "__sleuthPiLastSql";
	interface LastSql {
		sql: string;
		at: number;
		dataset: string;
	}
	const getLastSql = (): LastSql | undefined => (globalThis as Record<string, unknown>)[sqlKey] as LastSql | undefined;
	const setLastSql = (v: LastSql) => ((globalThis as Record<string, unknown>)[sqlKey] = v);

	const reconstruct = (ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		gaps = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type?: string; customType?: string; data?: GapEntry };
			if (e.type === "entry" && e.customType === "sleuth.gap" && e.data) gaps.push(e.data);
		}
	};
	pi.on("session_start", async (_event, ctx) => reconstruct(ctx as never));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx as never));

	pi.registerTool({
		name: "w2d_gap_record",
		label: "W2D gap record",
		description:
			"Record a words-to-data gap: a question no command could answer that you had to answer with w2d_sql. Every w2d_sql peek must be followed by one of these. The session's report ends with the gap list so it can be filed against words-to-data.",
		parameters: Type.Object({
			question: Type.String({ description: "The question the commands could not answer" }),
			sql: Type.String({ description: "The SQL that answered it" }),
			missingCommand: Type.String({ description: "The command or flag words_to_data should offer instead" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// A gap is only real if the SQL actually ran against the registered dataset.
			try {
				const dataset = getDatasetPath(ctx.cwd);
				const last = getLastSql();
				if (!last || last.sql !== params.sql || last.dataset !== dataset || Date.now() - last.at > 10 * 60 * 1000) {
					return fail(
						"A gap must record a query you actually ran with w2d_sql against the registered dataset, immediately before recording it. Run the query first, then record the gap.",
					);
				}
			} catch (err) {
				return fail(err instanceof W2dError ? err.message : String(err));
			}
			const entry: GapEntry = { ...params, at: new Date().toISOString() };
			gaps.push(entry);
			pi.appendEntry("sleuth.gap", entry);
			const remaining = gaps
				.map((g, i) => `${i + 1}. ${g.question}\n   sql: ${g.sql}\n   missing: ${g.missingCommand}`)
				.join("\n");
			return { content: [{ type: "text" as const, text: `Gap recorded. Gaps this session:\n${remaining}` }], details: undefined };
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
			const lines = gaps
				.map((g, i) => `${i + 1}. ${g.question}\n   sql: ${g.sql}\n   missing: ${g.missingCommand}`)
				.join("\n\n");
			ctx.ui.notify(`Gaps this session:\n\n${lines}`, "info");
		},
	});
}
