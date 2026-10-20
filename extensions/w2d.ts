/**
 * SLEUTH words_to_data tools.
 *
 * One tool per read-only `words_to_data` subcommand, plus the writes
 * (link-amendment, settle --verdict, add-bills, add-opinions), which are
 * blocked unless the user has granted write access for the session with
 * /dataset <path> --write. `w2d_raw` is the escape hatch for commands with no
 * tool of their own, and it runs read-only subcommands only: the write gate
 * holds there too, and the batch steps stay a person's job.
 */

// Type and StringEnum both come from pi-ai rather than typebox. pi re-exports
// Type from its own copy, and taking it from there means the schemas are built
// with the same TypeBox instance that validates tool arguments. A second typebox
// copy in this package's node_modules would make every Type.Optional parameter
// required: pi's validator keys off a symbol only its own copy stamps onto the
// schema.
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	addFlags,
	boundOutput,
	expandPath,
	getDatasetPath,
	hasWriteGrant,
	rawCommandError,
	setDatasetPath,
	w2d,
	W2dError,
	writeError,
	type FlagSpec,
} from "../src/w2d-common.ts";

const MAX_TEXT = 30_000;
// A JSON answer cut in half is unparseable, so it gets more room than a table.
const MAX_JSON = 120_000;

function ok(text: string, commandHint: string, maxChars: number = MAX_TEXT) {
	return { content: [{ type: "text" as const, text: boundOutput(text, maxChars, commandHint) }], details: undefined };
}

function fail(err: unknown) {
	const message = err instanceof W2dError ? err.message : err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true };
}

const Opt = {
	at: Type.Optional(Type.String({ description: "Expression date, e.g. 2025-07-30" })),
	from: Type.Optional(Type.String({ description: "Start expression, e.g. uscode/title_26@2025-07-18" })),
	to: Type.Optional(Type.String({ description: "End expression, e.g. uscode/title_26@2025-07-30" })),
	path: Type.Optional(Type.String({ description: "Provision path, e.g. uscode/title_26/.../section_174A" })),
	bill: Type.Optional(Type.String({ description: "Bill id, e.g. 119-hr-1" })),
	work: Type.Optional(Type.String({ description: "Work key, e.g. uscode/title_26 or publiclawdocument_119-21" })),
	json: Type.Optional(Type.Boolean({ description: "Return full JSON instead of bounded table output" })),
	limit: Type.Optional(Type.Number({ description: "Max rows for table output (CLI default 20)" })),
	all: Type.Optional(Type.Boolean({ description: "Every row, however many there are (the run says how many it held back)" })),
	exact: Type.Optional(Type.Boolean({ description: "Match --path exactly: that provision alone, not the paths beneath it" })),
};

const JsonFlag = { json: { flag: "--json", kind: "flag" as const } };
// The parameter schema for the same flag. JsonFlag is a flag descriptor for addFlags,
// not a schema: spreading it into Type.Object would make json a required property
// with no type, and the tool would reject a call that omits it.
const JsonParam = { json: Opt.json };

/** Run a read-only command with the dataset in force, and bound its output. */
async function run(
	command: string,
	params: Record<string, unknown>,
	spec: FlagSpec,
	signal: AbortSignal | undefined,
	ctx: { cwd: string },
	positionals: string[] = [],
) {
	const dataset = getDatasetPath(ctx.cwd);
	const args = addFlags([command, ...positionals], params, spec);
	const hint = `words_to_data ${[args[0], dataset, ...args.slice(1)].join(" ")}`;
	return ok(await w2d(args, signal, ctx.cwd), hint, params.json === true ? MAX_JSON : MAX_TEXT);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "w2d_dataset",
		label: "W2D dataset",
		description:
			"Register the words_to_data dataset (SQLite file) that every w2d_* tool reads. The agent may only register READ-ONLY access; writes (w2d_settle --verdict, w2d_link_amendment) require a human to run /dataset <path> --write. Returns the dataset path in force.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Path to the dataset .sqlite file (~/ and relative paths expand)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				if (params.path) {
					setDatasetPath(expandPath(params.path, ctx.cwd));
				}
				const resolved = getDatasetPath(ctx.cwd);
				return ok(
					`Dataset in force: ${resolved}\nWrite access: ${hasWriteGrant() ? "GRANTED (a human ran /dataset --write)" : "read-only"}`,
					"",
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_info",
		label: "W2D info",
		description:
			"Orient in a dataset: what it holds, links by kind, review state, methods run, and the declared scope with its gaps (a dataset that declared nothing cannot tell you 'out of scope' from 'not found'). Run this first. Wraps `words_to_data info`.",
		parameters: Type.Object({ ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("info", params, JsonFlag, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_expressions",
		label: "W2D expressions",
		description: "List every work and date held in the dataset. Wraps `words_to_data expressions`.",
		parameters: Type.Object({ work: Opt.work, ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("expressions", params, { work: { flag: "--work" }, ...JsonFlag }, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_bills",
		label: "W2D bills",
		description:
			"List the bills in the dataset and how many amendments each states. Note: the WITH CHANGES column reads 0 even when hundreds of links exist; count links with w2d_annotations instead. The command prints no sponsor, title or dates — those live in the sponsors/members tables no command reads, so they are a gap to record with w2d_gap_record. Wraps `words_to_data bills`.",
		parameters: Type.Object({ ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("bills", params, JsonFlag, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_validate",
		label: "W2D validate",
		description: "Report dataset faults and pipeline steps nobody has run. Wraps `words_to_data validate`.",
		parameters: Type.Object({ ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("validate", params, JsonFlag, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_search",
		label: "W2D search",
		description:
			"Search words in the text of a work. It searches every text field — heading, chapeau, content, proviso, continuation — and tags the field it matched, so a proviso hit is a real hit. Empty query with a --path and --snippet 0 prints whole fields of every node under the path. Search the date AFTER a change then BEFORE it: present after and absent before means added. Wraps `words_to_data search`.",
		parameters: Type.Object({
			query: Type.String({ description: 'Words to find; "" matches every field under --path' }),
			work: Opt.work,
			at: Opt.at,
			path: Opt.path,
			exact: Opt.exact,
			all: Opt.all,
			limit: Opt.limit,
			snippet: Type.Optional(Type.Number({ description: "Snippet width in words; 0 prints whole fields" })),
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run(
					"search",
					params,
					{
						work: { flag: "--work" },
						at: { flag: "--at" },
						path: { flag: "--path" },
						exact: { flag: "--exact", kind: "flag" },
						all: { flag: "--all", kind: "flag" },
						snippet: { flag: "--snippet" },
						limit: { flag: "--limit" },
						...JsonFlag,
					},
					signal,
					ctx,
					[String(params.query)],
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_diff",
		label: "W2D diff",
		description:
			"List the paths that changed between two dates of one work. TRAP: renumbering links echo across later windows, so a later window may report a move/add when the text is identical at both dates — read w2d_redesignation_report, and confirm with w2d_search (empty query, --path, --snippet 0) at both dates before reporting. --path lists the changed children of a provision; --exact is that provision alone. Wraps `words_to_data diff`.",
		parameters: Type.Object({
			from: Type.String({ description: "Start expression, e.g. uscode/title_26@2025-07-18" }),
			to: Type.String({ description: "End expression, e.g. uscode/title_26@2025-07-30" }),
			path: Opt.path,
			exact: Opt.exact,
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("diff", params, { from: { flag: "--from" }, to: { flag: "--to" }, path: { flag: "--path" }, exact: { flag: "--exact", kind: "flag" }, ...JsonFlag }, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_path",
		label: "W2D path",
		description:
			"Show one provision and the words that changed on it across a window. A parent path does not show its children's field changes: use w2d_diff --path on the parent, then this with exact: true on each child. For a provision new in the window it prints the words added. Wraps `words_to_data path`.",
		parameters: Type.Object({
			path: Type.String({ description: "Full provision path" }),
			from: Opt.from,
			to: Opt.to,
			exact: Opt.exact,
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run(
					"path",
					params,
					{ from: { flag: "--from" }, to: { flag: "--to" }, exact: { flag: "--exact", kind: "flag" }, ...JsonFlag },
					signal,
					ctx,
					[String(params.path)],
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_annotations",
		label: "W2D annotations",
		description:
			"List the amendments linked to a bill and/or a path, in a window or across the dataset. Each row names the amendment and its link ids. With --json, each link carries recorded.chosen (quoted_words | inside_placed_provision | renumbering | elimination), recorded.address_source (markup | olrc), recorded.changes_under_address, causes, and outdated. The authoritative way to count links. Wraps `words_to_data annotations`.",
		parameters: Type.Object({
			bill: Opt.bill,
			path: Opt.path,
			from: Opt.from,
			to: Opt.to,
			exact: Opt.exact,
			limit: Opt.limit,
			all: Opt.all,
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run(
					"annotations",
					params,
					{
						from: { flag: "--from" },
						to: { flag: "--to" },
						bill: { flag: "--bill" },
						path: { flag: "--path" },
						exact: { flag: "--exact", kind: "flag" },
						limit: { flag: "--limit" },
						all: { flag: "--all", kind: "flag" },
						...JsonFlag,
					},
					signal,
					ctx,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_residue",
		label: "W2D residue",
		description:
			"List a bill's amendments that no link names, with category (work | not_held | quiet | reviewed) and, for work, the stage that stopped the batch (address | window | resolve). --json adds address, window, candidate changes, law_section and OLRC rows; it is the only place the FULL amendment id appears besides show-bill --json. For the address of EVERY amendment, linked or not, with the reason it is unaddressed, use w2d_amendment_addresses. Wraps `words_to_data residue`.",
		parameters: Type.Object({ bill: Type.String({ description: "Bill id, e.g. 119-hr-1" }), ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("residue", params, { bill: { flag: "--bill" }, ...JsonFlag }, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_amendment_addresses",
		label: "W2D amendment-addresses",
		description:
			"For every amendment of a public law: the Code address it acts on, or the reason none is known ('section 112 is a section of another law, and nothing places it in the Code', 'no level above the clause says what it amends'). Start the residue address stage here — w2d_residue gives an address only for the rows it could not link. --amendment narrows to one id or the start of one. Wraps `words_to_data amendment-addresses`.",
		parameters: Type.Object({
			bill: Type.String({ description: "Bill id, e.g. 119-hr-1" }),
			amendment: Type.Optional(Type.String({ description: "One amendment, by full id or the start of it" })),
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run(
					"amendment-addresses",
					params,
					{ bill: { flag: "--bill" }, amendment: { flag: "--amendment" }, ...JsonFlag },
					signal,
					ctx,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_section_agreement",
		label: "W2D section-agreement",
		description:
			"The review queue: links whose own amendment words name a section other than the one the link sits on, plus links whose words could not be read at all. Per window it says how many agree, how many disagree, and how many could not be read, then prints the suspects weakest first. 'could not be read' is a limit of the reader, not a fault in the link — read them first, in the order printed, before the annotations --json heuristics. Wraps `words_to_data section-agreement`.",
		parameters: Type.Object({
			from: Opt.from,
			to: Opt.to,
			bill: Opt.bill,
			path: Opt.path,
			exact: Opt.exact,
			limit: Opt.limit,
			all: Opt.all,
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run(
					"section-agreement",
					params,
					{
						from: { flag: "--from" },
						to: { flag: "--to" },
						bill: { flag: "--bill" },
						path: { flag: "--path" },
						exact: { flag: "--exact", kind: "flag" },
						limit: { flag: "--limit" },
						all: { flag: "--all", kind: "flag" },
						...JsonFlag,
					},
					signal,
					ctx,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_redesignation_report",
		label: "W2D redesignation-report",
		description:
			"Every renumbering the dataset's bills state, weakest first, with why each statement was not placed. Read this before believing a 'moved' or 'added' change in a window later than the law: renumbering links echo across windows, which is the playbook's first trap. --bill narrows to one bill. Wraps `words_to_data redesignation-report`.",
		parameters: Type.Object({ bill: Opt.bill, ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("redesignation-report", params, { bill: { flag: "--bill-id" }, ...JsonFlag }, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_contradictions",
		label: "W2D contradictions",
		description:
			"The subjects the dataset holds more than one link about: duplication (one subject and object, linked in more than one window) and disagreement (one subject, different objects). A review queue, not a fault list — two laws can each be responsible for part of one change. Filter with --kind (e.g. legislature.redesignated_as) or --namespace (e.g. legislature). Wraps `words_to_data contradictions`.",
		parameters: Type.Object({
			kind: Type.Optional(Type.String({ description: "One link kind, e.g. legislature.redesignated_as" })),
			namespace: Type.Optional(Type.String({ description: "One namespace, e.g. legislature" })),
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run(
					"contradictions",
					params,
					{ kind: { flag: "--kind" }, namespace: { flag: "--namespace" }, ...JsonFlag },
					signal,
					ctx,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_cases_citing",
		label: "W2D cases-citing",
		description:
			"Which court opinions cite a provision, and whether it changed after each was filed. --chain walks each change on to the amendment, the bill, its sponsor and the House vote — the only way to reach a sponsor from a provision. Needs opinions in the dataset (w2d_fetch opinions); when there are none it says so, and 'no opinion cites it' then means 'the dataset holds none', not 'no court has'. Pass the citation as a court writes it (26 U.S.C. § 174) or the structural path. No --json: read the text. Wraps `words_to_data cases-citing`.",
		parameters: Type.Object({
			cites: Type.Optional(Type.String({ description: "Citation as a court writes it, e.g. 26 U.S.C. § 174" })),
			path: Opt.path,
			chain: Type.Optional(Type.Boolean({ description: "Walk each change on to amendment, bill, sponsor and vote" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (!params.cites && !params.path) {
					return fail(new W2dError("Give cites (e.g. '26 U.S.C. § 174') or path."));
				}
				return await run("cases-citing", params, { cites: { flag: "--cites" }, path: { flag: "--path" }, chain: { flag: "--chain", kind: "flag" } }, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_coverage",
		label: "W2D coverage",
		description:
			"Report annotation coverage of a window: how many changed paths no link claims, broken down by kind (changed under an address that already has one, added under an address that does, pure addition, pure removal, renumbering echo). This is the work queue, and it is per window: --from and --to are required, so name the work and dates you are working in. list defaults to true, the full unannotated path list (output is bounded either way); set it false for counts only. Catches changes missed even when an amendment is linked in part. Wraps `words_to_data coverage`.",
		parameters: Type.Object({
			from: Type.String({ description: "Start expression, e.g. uscode/title_26@2025-07-18" }),
			to: Type.String({ description: "End expression" }),
			list: Type.Optional(Type.Boolean({ description: "Print the full unannotated path list (default true); false is counts only" })),
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run(
					"coverage",
					{ ...params, list: params.list ?? true },
					{ from: { flag: "--from" }, to: { flag: "--to" }, list: { flag: "--list", kind: "flag" }, ...JsonFlag },
					signal,
					ctx,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_show_bill",
		label: "W2D show-bill",
		description:
			"Print a public law's own text: its sections, amendments, and effective-date clauses. --json prints full amendment ids and each amendment's amending actions and text. The change_count reads 0 and lies; count links with w2d_annotations. Wraps `words_to_data show-bill`.",
		parameters: Type.Object({ bill: Type.String({ description: "Bill id, e.g. 119-hr-1" }), ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("show-bill", params, JsonFlag, signal, ctx, [String(params.bill)]);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_votes",
		label: "W2D votes",
		description:
			"House roll calls on a bill, counted by the party the member held on the vote's date, with the votes whose party the date cannot settle listed by name. No command names an individual member's vote, or a bill's sponsors: that data is in the member_votes and sponsors tables and no command reads it — record it with w2d_gap_record and read it with w2d_sql. Label any party-level inference as outside knowledge. Wraps `words_to_data votes`.",
		parameters: Type.Object({ bill: Type.String({ description: "Bill id, e.g. 119-hr-1" }), ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("votes", params, JsonFlag, signal, ctx, [String(params.bill)]);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_settle",
		label: "W2D settle",
		description:
			"--explain (default, read-only): print a link's amendment words, the words at both ends of the change, the OLRC classification, and how the link was made. --verdict records a review (confirmed | refuted | disputed) and needs the session write grant (/dataset <path> --write). A link is never edited: refute it and record the right one with w2d_link_amendment. Wraps `words_to_data settle`.",
		parameters: Type.Object({
			link: Type.String({ description: "Link id (the short id annotations prints)" }),
			explain: Type.Optional(Type.Boolean({ description: "Explain how the link was made (default true)" })),
			verdict: Type.Optional(StringEnum(["confirmed", "refuted", "disputed"] as const)),
			reviewer: Type.Optional(Type.String({ description: "Reviewer identity, e.g. agent:sleuth. Required with --verdict" })),
			reason: Type.Optional(Type.String({ description: "The evidence. Required with --verdict" })),
			output: Type.Optional(Type.String({ description: "Compact-JSON dataset only: write to this new file instead of the input" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (params.verdict) {
					if (!hasWriteGrant()) return fail(writeError("settle --verdict"));
					if (!params.reviewer || !params.reason) {
						return fail(new W2dError("verdict requires reviewer and reason."));
					}
					const args = addFlags(["settle", "--link", params.link], params, {
						verdict: { flag: "--verdict" },
						reviewer: { flag: "--reviewer" },
						reason: { flag: "--reason" },
						output: { flag: "--output" },
					});
					return ok(
						await w2d(args, signal, ctx.cwd),
						`words_to_data settle --link ${params.link} --verdict ${params.verdict}`,
					);
				}
				return ok(
					await w2d(["settle", "--link", params.link, "--explain"], signal, ctx.cwd),
					`words_to_data settle --link ${params.link} --explain`,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_link_amendment",
		label: "W2D link-amendment",
		description:
			"Record that an amendment made a change (paths over the window), or that it has no link (noLink). Requires the session write grant. The amendment id must be the FULL hex id from w2d_residue --json or w2d_show_bill --json. The reason must quote the amendment's words and the words that changed: a reader will check you. Record the method resolve-residue@1. Wraps `words_to_data link-amendment`.",
		parameters: Type.Object({
			bill: Type.String({ description: "Bill id" }),
			amendment: Type.String({ description: "FULL hex amendment id" }),
			from: Opt.from,
			to: Opt.to,
			paths: Type.Optional(Type.Array(Type.String(), { description: "Changed paths (one per --path). Required for a link" })),
			noLink: Type.Optional(StringEnum(["not_held", "not_yet_in_corpus", "no_change", "other"] as const)),
			source: Type.String({ description: "Who is recording, e.g. agent:sleuth" }),
			reason: Type.String({ description: "What the amendment says and the words you saw change" }),
			method: Type.Optional(Type.String({ description: "Method name; default resolve-residue@1" })),
			output: Type.Optional(Type.String({ description: "Compact-JSON dataset only: write to this new file instead of the input" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (!hasWriteGrant()) return fail(writeError("link-amendment"));
				const args = ["link-amendment", "--bill", params.bill, "--amendment", params.amendment];
				if (params.noLink) {
					args.push("--no-link", params.noLink);
				} else {
					if (!params.from || !params.to || !params.paths || params.paths.length === 0) {
						return fail(new W2dError("A link needs from, to, and at least one path. A no-link conclusion needs noLink."));
					}
					args.push("--from", params.from, "--to", params.to);
					for (const p of params.paths) args.push("--path", p);
				}
				args.push("--source", params.source, "--method", params.method ?? "resolve-residue@1", "--reason", params.reason);
				if (params.output) args.push("--output", params.output);
				return ok(await w2d(args, signal, ctx.cwd), `words_to_data link-amendment --bill ${params.bill}`);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_fetch",
		label: "W2D fetch",
		description:
			"Fetch data from Congress.gov or CourtListener INTO the dataset: add bills (Congress API, needs CONGRESS_API_KEY in the environment) or court opinions by CourtListener opinion id (needs COURTLISTENER_API_KEY). Each opinion becomes one expression of a judicial/opinion_<id> work, searchable with w2d_search --work and queryable with w2d_cases_citing. This WRITES to the dataset and needs the session write grant (/dataset <path> --write). Afterwards add-classifications, link-by-evidence and redesignations are batch steps a person runs in the terminal. Results are cached under the shared words_to_data cache dir. Wraps `words_to_data add-bills` and `add-opinions`.",
		parameters: Type.Object({
			bills: Type.Optional(Type.String({ description: "Comma-separated Congress bill ids, e.g. '119-hr-998,119-s-1071'" })),
			opinions: Type.Optional(Type.String({ description: "Comma-separated CourtListener opinion ids" })),
			offline: Type.Optional(Type.Boolean({ description: "Read only the cache, never the network" })),
			cacheDir: Type.Optional(Type.String({ description: "Cache directory (default: the shared words_to_data cache)" })),
			output: Type.Optional(Type.String({ description: "Compact-JSON dataset only: write to this new file instead of the input" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (!hasWriteGrant()) return fail(writeError("add-bills / add-opinions"));
				if (!params.bills && !params.opinions) {
					return fail(new W2dError("Give bills (Congress ids) or opinions (CourtListener ids), or both."));
				}
				const dataset = getDatasetPath(ctx.cwd);
				const flags = addFlags([], params, {
					offline: { flag: "--offline", kind: "flag" },
					cacheDir: { flag: "--cache-dir" },
					output: { flag: "--output" },
				});
				const results: string[] = [];
				// add-bills and add-opinions are separate subcommands; run each.
				if (params.bills) results.push(await w2d(["add-bills", `--bills=${params.bills}`, ...flags], signal, ctx.cwd));
				if (params.opinions) results.push(await w2d(["add-opinions", `--opinions=${params.opinions}`, ...flags], signal, ctx.cwd));
				return ok(results.join("\n---\n"), `words_to_data add-bills/add-opinions ${dataset}`);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_raw",
		label: "W2D raw",
		description:
			"Escape hatch for read-only commands with no tool of their own: the dataset is inserted as the first argument and the rest is passed through verbatim. Allowed: info, expressions, bills, validate, search, diff, path, annotations, residue, coverage, show-bill, votes, cases-citing, contradictions, section-agreement, amendment-addresses, redesignation-report, and settle --explain. Everything that writes is refused here — use w2d_settle, w2d_link_amendment or w2d_fetch (write grant required); the batch steps (link-by-evidence, redesignations, add-classifications) and the builders (build-dataset, convert-dataset) stay a person's job. A read-only command this refuses as unknown is a gap to report, not a wall to go around.",
		parameters: Type.Object({
			command: Type.String({ description: "Read-only subcommand, e.g. contradictions" }),
			args: Type.Optional(Type.Array(Type.String(), { description: "Arguments after the dataset path" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const refusal = rawCommandError(params.command, params.args ?? []);
			if (refusal) return fail(refusal);
			try {
				return ok(
					await w2d([params.command, ...(params.args ?? [])], signal, ctx.cwd),
					`words_to_data ${params.command} ...`,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});
}
