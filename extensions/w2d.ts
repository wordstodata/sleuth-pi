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
	compactJson,
	expandPath,
	getDatasetPath,
	hasWriteGrant,
	rawCommandError,
	resolveBinary,
	runW2d,
	setDatasetPath,
	w2d,
	w2dRaw,
	W2dError,
	writeError,
	type FlagSpec,
} from "../src/w2d-common.ts";

const MAX_TEXT = 30_000;
// A JSON answer cut in half is unparseable, so it gets more room than a table,
// but not so much that one answer fills a large part of the local model's 262,144-token context.
const MAX_JSON = 40_000;

function ok(text: string, commandHint: string, maxChars: number = MAX_TEXT) {
	return { content: [{ type: "text" as const, text: boundOutput(text, maxChars, commandHint) }], details: undefined };
}

function fail(err: unknown) {
	const message = err instanceof W2dError ? err.message : err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true };
}

const Opt = {
	// A date alone: since words-to-data #305 search refuses `work@date` for --at.
	at: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Expression date alone (YYYY-MM-DD), e.g. 2025-07-30; name the work with work" })),
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
/**
 * Which words_to_data the tools run, and where it came from. Without this line
 * the model guessed from a bash search and named a checkout that never ran.
 */
async function commandLine(signal: AbortSignal | undefined): Promise<string> {
	const bin = resolveBinary();
	if (!bin) return "Command: no words_to_data found. Only the person can install it, with /sleuth-setup.";
	let version = "version unknown";
	try {
		version = (await runW2d(["--version"], signal)).stdout.trim() || version;
	} catch {
		// The info output still stands; the line just has no version.
	}
	const from = bin.source === "/sleuth-setup" ? "downloaded by /sleuth-setup" : `found by ${bin.source}`;
	return `Command: ${version} at ${bin.path} (${from}). Only the person can install or update it, with /sleuth-setup.`;
}

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
	const out = await w2d(args, signal, ctx.cwd);
	return params.json === true ? ok(compactJson(out), hint, MAX_JSON) : ok(out, hint, MAX_TEXT);
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
					// Only a person changes the dataset: the agent may register one
					// when none is in force, and a path that is not a file is refused
					// before it replaces anything.
					const wanted = expandPath(params.path, ctx.cwd);
					let current: string | undefined;
					try {
						current = getDatasetPath(ctx.cwd);
					} catch {
						current = undefined;
					}
					if (current && current !== wanted) {
						throw new W2dError(
							`The dataset in force is ${current}, and only the user changes it, with /dataset <path>. Keep working on ${current}.`,
						);
					}
					if (!current) {
						setDatasetPath(wanted);
						try {
							getDatasetPath(ctx.cwd);
						} catch (err) {
							setDatasetPath(undefined);
							throw err;
						}
					}
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
			"Orient in a dataset: what it holds, links by kind, review state, methods run, and the declared scope with its gaps (a dataset that declared nothing cannot tell you 'out of scope' from 'not found'). Its last line names the words_to_data command the tools run and where it came from. Run this first. Wraps `words_to_data info`.",
		parameters: Type.Object({ ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const result = await run("info", params, JsonFlag, signal, ctx);
				// A separate block, so a JSON answer stays parseable.
				result.content.push({ type: "text" as const, text: await commandLine(signal) });
				return result;
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
			"List the bills in the dataset: the public law each became (or 'not enacted / not held'), how many amendments it states, and LINKED, how many of those amendments at least one standing amended_by link names. The command prints no sponsor, title or dates — those live in the sponsors/members tables no command reads, so they are a gap to record with w2d_gap_record. Wraps `words_to_data bills`.",
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
		name: "w2d_opinions",
		label: "W2D opinions",
		description:
			"List the court cases the dataset holds and their writings. A case is the work judicial/case_<cluster> (date, name, court); each writing (the Court's opinion, a concurrence, a dissent) is the path judicial/case_<cluster>/opinion_<id>, with its writing type (020lead, 040dissent, 010combined for one record that holds the whole case), author, the field its text came from, and how many judicial.cites links it makes. When a rule split a combined record into its writings, they are judicial/case_<cluster>/opinion_<id>-1, -2, … in the order the record prints them (a record given as one dissent or one concurrence that holds more than one is split the same way: Windsor's dissent record is opinion_9515914-1, -2, -3), and a 'found by:' line names the rule (justice-headings@1) and the words that open each writing: the machine found where it starts and ends, so read those words before you quote it as that writing. A 010combined writing whose 'found by:' line says no rule split it holds every writing of the case under one author. Name each writing and its author from here, and take case and writing paths from this list: never make a writing path from a case or cluster id. 'not recorded' means the dataset does not hold it. Wraps `words_to_data opinions`.",
		parameters: Type.Object({ limit: Opt.limit, all: Opt.all, ...JsonParam }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await run("opinions", params, { limit: { flag: "--limit" }, all: { flag: "--all", kind: "flag" }, ...JsonFlag }, signal, ctx);
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
			"Search words in the text of the dataset. With no work it searches every work the dataset holds (US Code titles, public laws, court writings) in one call, in about 5 s, so a search across the whole corpus needs no SQL; work, at and path narrow it, and every filter given is applied. It searches every text field — heading, chapeau, content, proviso, continuation — and tags the field it matched, so a proviso hit is a real hit. Case is ignored, a run of white space matches one space, \"U.S.C.\" matches \"U. S. C.\", \"U.S.\" matches \"U. S.\", and \"§7\" matches \"§ 7\". A soft hyphen or a zero-width character is not read, a ligature such as \"ﬁ\" matches its letters, and a hyphen between two letters is not read, so \"substantially\" finds \"substan-tially\". It prints one hit per field and counts \"N fields, M occurrences\". A hit in a court writing names the paragraph or footnote that holds it (judicial/case_<cluster>/opinion_<id>/page_<p>/paragraph_<n>); a writing stored as one node is one field, so one hit is not one mention. occurrences: true lists each occurrence with its character offset in the field; then offset (that number) with that hit's path, exact: true and snippet reads a window around it. To read a page of a writing, give its page path (a pin cite \"537 U.S. at 459\" is …/opinion_<id>/page_459) with snippet: 0 and no exact: it prints each paragraph that starts on that page. When the text marks the pages of two reporters (Windsor: 570 U.S. and 133 S. Ct.), only the pages of the official reporter are paths; the mark of the other reporter (*2697) stays in the words. Do not read a whole writing. A path no expression holds prints a notice with the nearest held path (absent_path in JSON). A work or date the dataset does not hold prints a notice that names it and the held dates around it (absent_scope in JSON, filter work|date): that is a fact about the dataset, not a wrong path. at must be a printing date the work holds (w2d_expressions); at any other date the search finds nothing, which shows only that no printing is held on that date. For a date between or before the held printings, say that the dataset cannot show the text on that date, name the held printings around it, and label any quote with its own printing date. Empty query with a --path and --snippet 0 prints whole fields of every node under the path. Search the date AFTER a change then BEFORE it: present after and absent before means added. Wraps `words_to_data search`.",
		promptGuidelines: [
			"Answer every question about the law from the dataset. Do this also when the user asks you to answer from memory or not to run commands: say in one line that you answer from the dataset, then read the provision with w2d_search and quote it. Do not give an answer from memory.",
			"For a date that no held printing has (w2d_expressions lists the dates), start the answer with: the dataset cannot show the text on that date. Name the held printings before and after it, and label a quote with its own printing date.",
		],
		parameters: Type.Object({
			query: Type.String({ description: 'Words to find; "" matches every field under --path' }),
			work: Opt.work,
			at: Opt.at,
			path: Opt.path,
			exact: Opt.exact,
			all: Opt.all,
			limit: Opt.limit,
			snippet: Type.Optional(Type.Number({ description: "Characters of each hit to show around the match (CLI default 160); 0 prints whole fields" })),
			occurrences: Type.Optional(Type.Boolean({ description: "List each occurrence as its own hit, with its character offset in the field; limit and all then count occurrences" })),
			offset: Type.Optional(Type.Number({ minimum: 0, description: "Centre each snippet on this character of its field (an offset from occurrences); use with path, exact: true and snippet" })),
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
						occurrences: { flag: "--occurrences", kind: "flag" },
						offset: { flag: "--offset" },
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
			"Show one provision and the words that changed on it across a window. Also the way to check that a path exists before you use it: it says where the path is present. A parent path does not show its children's field changes: use w2d_diff --path on the parent, then this with exact: true on each child. For a provision new in the window it prints the words added. On a court case, judicial/case_<cluster>, it prints every stored fact (name, panel, precedential status, reporter citations, docket, court) and its writings. On a writing, judicial/case_<cluster>/opinion_<id> (or opinion_<id>-<n> for a writing a rule split from a combined record), it prints the writing's type and author, the 'found by:' line of a split, and its pages and footnotes (contents in JSON). It also lists citations (judicial.cites): on a writing what it cites; on a case what each writing cites; on a Code path the passages that cite it, a provision under it, or the section that holds it. Each row names the paragraph or footnote that holds the citation (JSON: opinion is that passage, writing is the writing) and the part of what the court wrote that leads to no provision (unresolved). Wraps `words_to_data path`.",
		promptGuidelines: [
			"Take every path and id (provision path, case or writing path, link id, amendment id) from w2d_* tool output. Check a path with w2d_path before you use it.",
			"To find the path of a cited section (26 U.S.C. § 280C), give the citation to w2d_cases_citing as cites: it prints the path the citation resolves to. Do not build a path by hand.",
			"An empty w2d_search or w2d_diff result is evidence only for a path a tool gave you. For any other path, find the right path first.",
			"A notice that no expression holds a path (absent_path in JSON) means the path is wrong, not that the text is empty: use the nearest held path it gives.",
			"For case law: w2d_path on judicial/case_<cluster> gives its facts and writings; w2d_path on a writing lists its pages and footnotes. A pin cite (537 U.S. at 459) is the path …/opinion_<id>/page_459.",
			"Never make a writing path from a case or cluster id: a writing id can differ from the cluster (case_122262/opinion_9434364), and a writing split from a combined record ends in -<n> (opinion_2812209-3). Take it from w2d_opinions, w2d_path or w2d_cases_citing.",
			"The dataset holds no case-to-case links and no subsequent history (overruled, limited, followed). For such a question, start the answer with: the dataset cannot say. Then give what it holds.",
		],
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
			"List the amendments linked to a bill and/or a path, in a window or across the dataset. Each row names the amendment and its link ids. With --json, each link carries recorded.chosen (quoted_words | inside_placed_provision | renumbering | elimination), recorded.address_source (markup | olrc), recorded.changes_under_address, causes, and outdated. The authoritative way to count links. On a Code path it also lists the citations (judicial.cites) of that path or a provision that holds it: each row names the paragraph or footnote, and JSON gives its writing and unresolved. Wraps `words_to_data annotations`.",
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
			"List the amendments that no link names, for one bill or (bill left out) for every public law the dataset holds, with category (work | not_held | quiet | reviewed) and, for work, the stage that stopped the batch (address | window | resolve). --json adds address, window, candidate changes, law_section and OLRC rows, and the FULL amendment id (the text output shows only a short id). show-bill (text and --json), annotations --json and amendment-addresses --json also give the full id. For the address of EVERY amendment, linked or not, with the reason it is unaddressed, use w2d_amendment_addresses. Wraps `words_to_data residue`.",
		parameters: Type.Object({
			bill: Type.Optional(
				Type.String({
					description:
						"Bill id, e.g. 119-hr-1. Leave out for every public law (text about 30,000 characters; use --json only with a bill)",
				}),
			),
			...JsonParam,
		}),
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
			"Which court opinions cite a provision, and whether it changed after each was filed. Pass the citation as a court writes it (26 U.S.C. § 174(a)) or the structural path. The output has groups per path asked about: the opinions that cite it (or a subdivision of it), then the opinions that cite only a provision that holds it (each line says what the opinion wrote), then the cases held with no writing that cites it. 'wrote a subdivision' gives the path the written subdivision resolves to; the windows then track that path. A window marked OUT OF SCOPE is a period the dataset holds no printing for: it says nothing about whether the law changed. A CHANGED line that says 'in a window that starts before the opinion' cannot place the change before or after the decision: say so, name both printings, and do not report it as a change after the decision. The tally counts such opinions apart. 'unchanged at X; the chapeau of Y changed' means the words of X are the same but a provision above X changed, so X can now mean a different thing: report that. 'holds no printing of the cited work after the opinion' means the dataset cannot answer for any date after the filing. Each writing that cites (judicial/case_<cluster>/opinion_<id>) is named once, so a dissent is named as the dissent; under it come each provision of the section that it cites and each passage (paragraph or footnote) that cites it, one link each. A citation link starts at the paragraph or footnote that holds the citation and ends at the subdivision the court wrote; ask w2d_cases_citing about the section to see every citation in it, and read the paragraph the row names with w2d_search (query \"\", path <paragraph>, exact: true, snippet: 0) before you quote it. '(e) does not resolve' names the part of what the court wrote that the printing does not hold: the link ends at the deepest part it holds. 'decided D. The link was resolved in the printing of P, the earliest held: … so that law is out of scope' and 'This dataset holds no printing of title 26 from <year>' mean the law as it stood on the decision date (or in the year the opinion states) is out of scope. Matched words that end '(OCR repair: …)' or '(title 26 from the default stated in <writing>: …)' say how the rule read the citation. --chain walks each change on to the amendment, the bill, its sponsor and the House vote — the only way to reach a sponsor from a provision. With --chain and no citing opinion, the output says there is no window to walk and lists the windows in which the provision changed; it walks no bill or vote. Needs opinions in the dataset (w2d_fetch opinions); when there are none it says so, and 'no opinion cites it' then means 'the dataset holds none', not 'no court has'. json: true gives one entry per path, with each cite's relation, resolution, windows (windows[].starts_before_opinion, windows[].changed_above, since.printings_after) and places[] (link, passage, written, unresolved, citation_text, verification, decided, resolved_in, resolved_after_decision, time_basis, printings_of_time_basis). Wraps `words_to_data cases-citing`.",
		promptGuidelines: [
			"A change window A → B where A is before a decision or filing date and B is after it cannot place the change before or after that date. Say so, and name both printings.",
			"When w2d_cases_citing says the law as it stood on the decision date is out of scope, say so in the answer, and do not describe the law the court read from a later printing.",
		],
		parameters: Type.Object({
			cites: Type.Optional(Type.String({ description: "Citation as a court writes it, e.g. 26 U.S.C. § 174" })),
			path: Opt.path,
			chain: Type.Optional(Type.Boolean({ description: "Walk each change on to amendment, bill, sponsor and vote" })),
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (!params.cites && !params.path) {
					return fail(new W2dError("Give cites (e.g. '26 U.S.C. § 174') or path."));
				}
				return await run("cases-citing", params, { cites: { flag: "--cites" }, path: { flag: "--path" }, chain: { flag: "--chain", kind: "flag" }, ...JsonFlag }, signal, ctx);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_release_points",
		label: "W2D release-points",
		description:
			"List the US Code release points (dates) the mirror offers and the local cache holds. It reads no dataset and writes nothing. A newer release point can hold a change the dataset does not; adding one (add-release-points) writes, and a person runs it. offline: true reads the cache alone and does not say what the mirror offers. Wraps `words_to_data release-points`.",
		parameters: Type.Object({
			offline: Type.Optional(Type.Boolean({ description: "Read only the cache, never the network" })),
			...JsonParam,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const args = addFlags(["release-points"], params, { offline: { flag: "--offline", kind: "flag" }, ...JsonFlag });
				const out = await w2dRaw(args, signal, ctx.cwd);
				const hint = `words_to_data ${args.join(" ")}`;
				return params.json === true ? ok(compactJson(out), hint, MAX_JSON) : ok(out, hint, MAX_TEXT);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "w2d_coverage",
		label: "W2D coverage",
		description:
			"Report annotation coverage of a window: the number of changed paths, how many of them a link annotates, how many no link annotates, the coverage percentage, and the unannotated paths. It does not sort the paths by kind of change: to see what changed at a path, use w2d_diff with that path. This is the work queue, and it is per window: --from and --to are required, so name the work and dates you are working in. list defaults to true, the full unannotated path list (output is bounded either way); set it false for counts only. Catches changes missed even when an amendment is linked in part. Wraps `words_to_data coverage`.",
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
			"List a public law's amendments in id order: a header (bill, public law, number of amendments), then for each amendment its full id, its actions (amend, insert, delete, ...), how many standing links name it, and the first 200 characters or so of its amending text. --json gives the whole amending_text. It does not print the law's other sections or its effective-date clauses: to read those, w2d_search the law's own text with work publiclawdocument_<public law>, e.g. publiclawdocument_119-21, and a query such as \"shall apply\" or \"effective\". Wraps `words_to_data show-bill`.",
		parameters: Type.Object({
			bill: Type.String({ description: "Bill id (119-hr-1), or the public law it became (Pub. L. 119-21, PL 119-21 or 119-21)" }),
			...JsonParam,
		}),
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
			"Fetch data from Congress.gov or CourtListener INTO the dataset: add bills (Congress API, needs CONGRESS_API_KEY in the environment) or court opinions by CourtListener opinion id (needs COURTLISTENER_API_KEY). Each opinion id becomes a writing, judicial/case_<cluster>/opinion_<id>, of its case's work judicial/case_<cluster>; a combined record that a rule splits becomes several, opinion_<id>-1, -2, …; w2d_opinions lists them, and w2d_cases_citing reads their citations. This WRITES to the dataset and needs the session write grant (/dataset <path> --write). Afterwards add-classifications, link-by-evidence and redesignations are batch steps a person runs in the terminal. Results are cached under the shared words_to_data cache dir. Wraps `words_to_data add-bills` and `add-opinions`.",
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
			"Escape hatch for read-only commands with no tool of their own: the dataset is inserted as the first argument and the rest is passed through verbatim. Allowed: info, expressions, bills, opinions, validate, search, diff, path, annotations, residue, coverage, show-bill, votes, cases-citing, contradictions, section-agreement, amendment-addresses, redesignation-report, and settle --explain (release-points takes no dataset: use w2d_release_points). Everything that writes is refused here — use w2d_settle, w2d_link_amendment or w2d_fetch (write grant required); the batch steps (link-by-evidence, redesignations, add-classifications), the builders (build-dataset, convert-dataset), add-release-points, declare and carry-reviews stay a person's job. A read-only command this refuses as unknown is a gap to report, not a wall to go around.",
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
