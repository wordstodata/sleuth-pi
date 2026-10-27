/**
 * Shared helpers for the SLEUTH tools: locating the words_to_data binary,
 * resolving and validating the dataset path, and running the CLI.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const W2D_BINARY_ENV = "W2D_BIN";
export const W2D_DATASET_ENV = "W2D_DATASET";

/**
 * The folder /sleuth-setup manages: the release binary in `bin/` and the
 * example dataset. It is under pi's agent directory (`~/.pi/agent/sleuth`, or
 * under PI_CODING_AGENT_DIR), next to the pi state it belongs with.
 */
export function managedDir(): string {
	return join(getAgentDir(), "sleuth");
}

export function managedBinaryPath(): string {
	return join(managedDir(), "bin", process.platform === "win32" ? "words_to_data.exe" : "words_to_data");
}

export function exampleDatasetPath(): string {
	return join(managedDir(), "example.sqlite");
}

/**
 * The release binary in the default words-to-data checkout. homedir() is
 * called here rather than at module scope: it can be unavailable, and a throw
 * on import would take down every extension that imports this file.
 */
function checkoutBinary(): string | undefined {
	const home = homedir();
	if (!home) return undefined;
	const candidate = join(home, "words-to-data", "target", "release", "words_to_data");
	return existsSync(candidate) ? candidate : undefined;
}

function pathBinary(): string | undefined {
	const names = process.platform === "win32" ? ["words_to_data.exe", "words_to_data"] : ["words_to_data"];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
	}
	return undefined;
}

export interface ResolvedBinary {
	path: string;
	source: "/dataset --bin" | "W2D_BIN" | "/sleuth-setup" | "checkout" | "PATH";
}

/**
 * The words_to_data binary SLEUTH runs, or undefined when there is none.
 * Order: /dataset --bin, W2D_BIN, the /sleuth-setup binary, the checkout, PATH.
 * The setup binary comes before PATH because a person ran /sleuth-setup to get
 * it: an older `cargo install` on PATH must not shadow the update.
 */
export function resolveBinary(): ResolvedBinary | undefined {
	const override = state().binaryPath;
	if (override) return { path: override, source: "/dataset --bin" };
	const fromEnv = process.env[W2D_BINARY_ENV];
	if (fromEnv) return { path: fromEnv, source: "W2D_BIN" };
	const managed = managedBinaryPath();
	if (existsSync(managed)) return { path: managed, source: "/sleuth-setup" };
	const checkout = checkoutBinary();
	if (checkout) return { path: checkout, source: "checkout" };
	const onPath = pathBinary();
	return onPath ? { path: onPath, source: "PATH" } : undefined;
}

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export class W2dError extends Error {}

/**
 * Session state shared across the extension modules (w2d.ts, w2d-sql.ts,
 * w2d-guard.ts). Pi loads each extension file in its own jiti module
 * instance, so a module-level variable here is NOT shared between them —
 * this globalThis slot is the single source of truth.
 */
interface SleuthState {
	// Explicit `| undefined` so the setters below can clear a value under
	// exactOptionalPropertyTypes.
	datasetPath?: string | undefined;
	binaryPath?: string | undefined;
	writeGranted: boolean;
}

const STATE_KEY = "__sleuthPiState";

function state(): SleuthState {
	const g = globalThis as Record<string, unknown>;
	if (!g[STATE_KEY]) g[STATE_KEY] = { writeGranted: false } satisfies SleuthState;
	return g[STATE_KEY] as SleuthState;
}

/** Set by the /dataset command or the W2D_BIN environment variable. */
export function setBinaryPath(path: string | undefined): void {
	state().binaryPath = path;
}

export function getBinaryPath(): string {
	return resolveBinary()?.path ?? "words_to_data";
}

/** The write grant, set only by /dataset --write (a human action). */
export function setWriteGrant(granted: boolean): void {
	state().writeGranted = granted;
}

export function hasWriteGrant(): boolean {
	return state().writeGranted;
}

/** Expand a leading ~ and resolve relative paths against the given base. */
export function expandPath(path: string, base: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(base, path);
}

/** Set by the /dataset command or the w2d_dataset tool. */
export function setDatasetPath(path: string | undefined): void {
	state().datasetPath = path;
}

export function getDatasetPath(cwd: string = process.cwd()): string {
	const path = state().datasetPath ?? process.env[W2D_DATASET_ENV];
	if (!path) {
		throw new W2dError(
			`No dataset is registered. Run /dataset <path-to-sqlite> first, or set ${W2D_DATASET_ENV}.`,
		);
	}
	const resolved = expandPath(path, cwd);
	if (!existsSync(resolved) || !statSync(resolved).isFile()) {
		throw new W2dError(
			`Dataset not found: ${resolved} is not a file. The dataset is registered by a human: ask the user to run /dataset <path-to-sqlite> (add --write only if this dataset may be modified).`,
		);
	}
	return resolved;
}

/**
 * Register the dataset every w2d_* tool reads, as /dataset does, and set the
 * write grant. /sleuth-setup registers the example dataset through here too, so
 * both commands check and report in the same way. Returns false, with the
 * reason shown, when the path is not a file.
 */
export function registerDataset(ctx: ExtensionContext, target: string, write: boolean): boolean {
	// Validate now: a path that does not exist fails here, not on first tool call.
	const path = expandPath(target, ctx.cwd);
	try {
		setDatasetPath(path);
		// getDatasetPath re-checks existence and throws W2dError if missing.
		getDatasetPath(ctx.cwd);
	} catch (err) {
		setDatasetPath(undefined);
		ctx.ui.notify(err instanceof W2dError ? err.message : String(err), "error");
		return false;
	}
	setWriteGrant(write);
	if (ctx.mode === "tui") {
		ctx.ui.setStatus("sleuth-dataset", `w2d: ${path.split("/").pop()}${write ? " (WRITE)" : ""}`);
	}
	ctx.ui.notify(
		`Dataset registered: ${path}\nWrite access: ${write ? "GRANTED for this session (settle --verdict, link-amendment)" : "read-only"}`,
		write ? "warning" : "info",
	);
	return true;
}

/**
 * The subcommands that only read (`words_to_data` groups them under
 * "Inspection (read-only)"). `w2d_raw` allows nothing else, so a command added
 * upstream stays unavailable here until it is classified — a refusal that says
 * so is a gap to report, not a write hole.
 */
export const READ_ONLY_SUBCOMMANDS = [
	"info",
	"expressions",
	"bills",
	"opinions",
	"validate",
	"search",
	"diff",
	"path",
	"annotations",
	"residue",
	"coverage",
	"show-bill",
	"votes",
	"cases-citing",
	"contradictions",
	"section-agreement",
	"amendment-addresses",
	"redesignation-report",
] as const;

/** Commands that write, allowed only with the session's write grant. */
export const GATED_WRITE_SUBCOMMANDS = ["settle", "link-amendment", "add-bills", "add-opinions"] as const;

/**
 * Commands no agent runs. The batch steps are a person's, per the playbook; the
 * builders take their output as the positional argument `w2d` fills with the
 * registered dataset, so `w2d_raw build-dataset --uslm-dates …` would write a
 * new dataset over the one in force. `add-release-points` and `declare` change
 * the dataset in force, and the playbook gives them to a person.
 * `carry-reviews` is a step of a rebuild: it reads a second, old dataset
 * (`--from`) and writes the reviews it carries into the new one in one batch.
 */
export const HUMAN_ONLY_SUBCOMMANDS = [
	"link-by-evidence",
	"redesignations",
	"add-classifications",
	"build-dataset",
	"convert-dataset",
	"add-release-points",
	"declare",
	"carry-reviews",
] as const;

/**
 * Read-only commands that take no dataset. `w2d_raw` inserts the dataset as the
 * first argument, so these run only through their own tool.
 */
export const DATASETLESS_SUBCOMMANDS = { "release-points": "w2d_release_points" } as const;

/**
 * Why `w2d_raw` must refuse a subcommand, or undefined to run it. Raw is the
 * read-only escape hatch: writes go through the tool that validates them
 * (`settle --verdict` needs a reviewer and a reason, `link-amendment` needs
 * paths), so raw refuses every writer even when the session holds the grant.
 * `settle --explain` is the one read path of a writing command, and it passes.
 */
export function rawCommandError(command: string, args: string[]): string | undefined {
	if (READ_ONLY_SUBCOMMANDS.includes(command as (typeof READ_ONLY_SUBCOMMANDS)[number])) return undefined;
	const ownTool = (DATASETLESS_SUBCOMMANDS as Record<string, string>)[command];
	if (ownTool) return `\`${command}\` takes no dataset, so w2d_raw cannot run it: use ${ownTool}.`;
	if (command === "settle") {
		if (args.includes("--verdict")) return "w2d_raw does not write: record a verdict with w2d_settle (it needs the write grant, a reviewer and a reason).";
		return args.includes("--explain") ? undefined : "w2d_raw runs settle only with --explain; use w2d_settle.";
	}
	if ((HUMAN_ONLY_SUBCOMMANDS as readonly string[]).includes(command)) {
		return `w2d_raw will not run \`${command}\`: it is a batch step a person runs in the terminal, and its output path is the dataset in force. Ask the user to run \`words_to_data ${command} <dataset> …\`.`;
	}
	if ((GATED_WRITE_SUBCOMMANDS as readonly string[]).includes(command)) {
		return `w2d_raw does not write: use the w2d_* tool for \`${command}\`, which checks the session write grant.`;
	}
	return `w2d_raw does not know the subcommand \`${command}\`. Allowed: the read-only commands (${READ_ONLY_SUBCOMMANDS.join(", ")}), plus settle --explain. A read-only command missing from that list is a gap in this package — report it rather than working around it.`;
}

/** The refusal every write goes through: the grant is a human's to give. */
export function writeError(command: string): string {
	return `Write access has not been granted this session, so \`${command}\` is refused. Ask the user to run /dataset <path> --write.`;
}

/** A flag spec for {@link addFlags}: `--flag` alone, or `--flag <value>`, or repeated for a list. */
export interface FlagSpec {
	[name: string]: { flag: string; kind?: "flag" | "list" };
}

/**
 * Append `--flag value` for every parameter that is set. `kind: "flag"` (or a
 * `true` value) appends the flag alone; `kind: "list"` repeats it per item.
 */
export function addFlags(args: string[], params: Record<string, unknown>, spec: FlagSpec): string[] {
	for (const [name, { flag, kind }] of Object.entries(spec)) {
		const value = params[name];
		if (value === undefined || value === null || value === false || value === "") continue;
		// words_to_data refuses --limit beside --all, and all already asks for every row.
		if (flag === "--limit" && params.all === true) continue;
		if (kind === "flag" || value === true) args.push(flag);
		else if (kind === "list") for (const item of value as (string | number)[]) args.push(flag, String(item));
		else args.push(flag, String(value));
	}
	return args;
}

/** Run words_to_data with args (the dataset path must already be included). */
export function runW2d(args: string[], signal?: AbortSignal): Promise<RunResult> {
	const bin = getBinaryPath();
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new W2dError("aborted before launch"));
			return;
		}
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let truncated = false;
		const MAX_BYTES = 4 * 1024 * 1024;
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_BYTES) stdout += chunk.toString("utf8");
			else truncated = true;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_BYTES) stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			reject(new W2dError(`Failed to launch ${bin}: ${err.message}. Ask the user to run /sleuth-setup, which downloads words_to_data, or to set ${W2D_BINARY_ENV}.`));
		});
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort);
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(new W2dError("aborted"));
				return;
			}
			resolve({ exitCode: code ?? -1, stdout, stderr, truncated } as RunResult & { truncated: boolean });
		});
	});
}

/**
 * Run a words_to_data command with the dataset as its first argument.
 * Returns stdout on exit code 0; throws W2dError with stderr otherwise.
 */
export async function w2d(args: string[], signal?: AbortSignal, cwd: string = process.cwd()): Promise<string> {
	const command = args[0];
	if (!command) throw new W2dError("words_to_data needs a command");
	const dataset = getDatasetPath(cwd);
	const result = await runW2d([command, dataset, ...args.slice(1)], signal);
	if (result.exitCode !== 0) {
		const detail = (result.stderr || result.stdout).trim().slice(0, 4000);
		throw new W2dError(`words_to_data ${args.join(" ")} failed (exit ${result.exitCode}):\n${detail}`);
	}
	return result.stdout;
}

/**
 * Run a words_to_data command with the arguments given verbatim, with no dataset
 * inserted. For commands that take their input differently (build-dataset) or read
 * from stdin (fetch). Still gated: w2d_raw only ever reaches a read-only command.
 */
export async function w2dRaw(args: string[], signal?: AbortSignal, cwd: string = process.cwd()): Promise<string> {
	const command = args[0];
	if (!command) throw new W2dError("words_to_data needs a command");
	const result = await runW2d([command, ...args.slice(1)], signal);
	if (result.exitCode !== 0) {
		const detail = (result.stderr || result.stdout).trim().slice(0, 4000);
		throw new W2dError(`words_to_data ${args.join(" ")} failed (exit ${result.exitCode}):\n${detail}`);
	}
	return result.stdout;
}

/**
 * The form of a SQL statement used to match a recorded gap to the query that
 * ran: white space collapsed, trailing semicolons dropped. Case is kept, because
 * it is significant inside string literals.
 */
export function normalizeSql(sql: string): string {
	return sql.replace(/[;\s]+$/, "").replace(/\s+/g, " ").trim();
}

/**
 * The SQL with its string literals, quoted names and comments made blank, so a
 * keyword test does not see words inside them ('%delete%', "update").
 */
function maskSql(sql: string): string {
	return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => " ".repeat(m.length));
}

/** The PRAGMAs that only read the schema, which w2d_sql runs as statements. */
export const READ_ONLY_PRAGMAS = [
	"table_info",
	"table_xinfo",
	"table_list",
	"index_list",
	"index_info",
	"index_xinfo",
	"foreign_key_list",
	"database_list",
] as const;

const STATEMENT_KEYWORDS = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b|\breplace\s+into\b/i;
const READ_PRAGMA = new RegExp(`^pragma\\s+(?:\\w+\\s*\\.\\s*)?(${READ_ONLY_PRAGMAS.join("|")})\\s*(?:\\([^()]*\\))?$`, "i");

/**
 * Why w2d_sql refuses a statement, or undefined when it runs it. The dataset is
 * opened read-only, and that is the real guard: SQLite itself refuses every
 * write. This check gives a clear message before the query runs, and it must
 * not refuse reads: the replace() string function, pragma_table_info('x') and
 * PRAGMA table_info(x) are reads (sleuth-pi #21: 74 refused reads in 64 runs).
 */
export function sqlReadError(sql: string): string | undefined {
	const masked = maskSql(sql.trim()).replace(/[;\s]+$/, "").trim();
	if (masked.includes(";")) return "Only one statement per call.";
	if (/^pragma\b/i.test(masked)) {
		if (READ_PRAGMA.test(masked)) return undefined;
		return `Only the schema PRAGMAs (${READ_ONLY_PRAGMAS.join(", ")}) are allowed, with no "=". For other values use the table-valued form, e.g. SELECT name FROM pragma_table_info('links').`;
	}
	if (!/^(select|with|explain|values)\b/i.test(masked)) {
		return "Only SELECT / WITH / EXPLAIN / VALUES statements and schema PRAGMAs are allowed. The dataset is opened read-only; make a read a gap finding with w2d_gap_record instead of writing.";
	}
	const keyword = STATEMENT_KEYWORDS.exec(masked)?.[0];
	if (keyword) return `Statement contains a write statement and was rejected: ${keyword.replace(/\s+/g, " ")}`;
	return undefined;
}

/** Run a command and parse stdout as JSON. */
export async function w2dJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
	const out = await w2d([...args, "--json"], signal);
	try {
		return JSON.parse(out) as T;
	} catch {
		throw new W2dError(`Could not parse JSON from \`words_to_data ${args.join(" ")} --json\`. First 500 chars:\n${out.slice(0, 500)}`);
	}
}

/**
 * The same JSON without the indentation the CLI prints, which is about 40% of
 * it. The model reads compact JSON as well, and a JSON answer must fit whole
 * under its bound: cut in half, it cannot be parsed. Text that is not JSON
 * comes back unchanged.
 */
export function compactJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text));
	} catch {
		return text;
	}
}

/**
 * Trim very long tool results. The note names the way out that works: a bounded
 * result is a query that was too wide, and a truncated JSON array cannot be
 * parsed, so telling the model to add --json would not help.
 */
export function boundOutput(text: string, maxChars: number, commandHint: string): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[Truncated at ${maxChars} characters. Narrow the query (--path, --work, --at, --bill) or cap it (--limit) rather than asking for more. The command was: ${commandHint}]`;
}

/**
 * How many consecutive words of the source text a write reason must quote.
 * Four words are not enough: "is amended by striking" and "is amended to read"
 * open most amendments, so a run of four can be boilerplate that says nothing
 * of this amendment. Five words reach past that phrase in most amendments, and
 * a quote of the struck or inserted words is easily five. A source text shorter
 * than this must be quoted whole.
 */
export const REASON_QUOTE_WORDS = 5;

/** The reasons a model writes when it has no reason yet (sleuth-pi #23: "placeholder"). */
const PLACEHOLDER_REASONS = new Set([
	"placeholder",
	"todo",
	"tbd",
	"tba",
	"fixme",
	"reason",
	"the reason",
	"evidence",
	"the evidence",
	"x",
	"xx",
	"xxx",
	"n a",
	"na",
	"none",
	"test",
	"dummy",
	"lorem ipsum",
	"see above",
	"see below",
	"",
]);

/**
 * The words of a text, for comparing a quote with its source: lower case, and
 * letters and digits only. Quote marks, dashes, punctuation and white space are
 * all dropped, so a straight quote matches a curly one, "-" matches "—", and a
 * line break in the CLI output matches a space in the reason.
 */
export function quoteWords(text: string): string[] {
	return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** True when the reason holds `n` consecutive words of the source (all of it, when it is shorter). */
export function quotesSource(reason: string, source: string, n: number = REASON_QUOTE_WORDS): boolean {
	const said = quoteWords(reason);
	const words = quoteWords(source);
	if (words.length === 0) return false;
	const size = Math.min(n, words.length);
	if (said.length < size) return false;
	const runs = new Set<string>();
	for (let i = 0; i + size <= words.length; i++) runs.add(words.slice(i, i + size).join(" "));
	for (let i = 0; i + size <= said.length; i++) if (runs.has(said.slice(i, i + size).join(" "))) return true;
	return false;
}

/**
 * Why a write must refuse its reason before any text is read, or undefined.
 * A placeholder ("placeholder", "TODO", "x", nothing) is refused by name; any
 * other reason shorter than the quote it must hold is refused as too short.
 * `howTo` tells the model where to find the words to quote.
 */
export function placeholderReasonError(reason: string | undefined, howTo: string): string | undefined {
	const words = quoteWords(reason ?? "");
	if (PLACEHOLDER_REASONS.has(words.join(" "))) {
		return `The reason ${JSON.stringify((reason ?? "").trim())} is a placeholder, so nothing was recorded. ${howTo}`;
	}
	if (words.length < REASON_QUOTE_WORDS) {
		return `The reason ${JSON.stringify((reason ?? "").trim())} has ${words.length} word(s), too few to quote the evidence, so nothing was recorded. ${howTo}`;
	}
	return undefined;
}

/** Why a write must refuse a reason that quotes none of its source text, or undefined. */
export function unquotedReasonError(reason: string, source: string, howTo: string): string | undefined {
	if (quotesSource(reason, source)) return undefined;
	return `The reason quotes no run of ${REASON_QUOTE_WORDS} consecutive words of the evidence, so nothing was recorded. ${howTo}`;
}
