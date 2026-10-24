/**
 * /sleuth-setup: download words_to_data and the example dataset, then register
 * the dataset read-only. It is a person's command, not a tool, so the model
 * cannot run it: only a person downloads 5 GB or changes the dataset in force.
 *
 *   /sleuth-setup                 binary (install or update) + example dataset
 *   /sleuth-setup --no-example    binary only
 *   /sleuth-setup --yes           no confirm before the 284 MB download (print mode)
 */

import { existsSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { exampleDatasetPath, managedBinaryPath, registerDataset, resolveBinary } from "../src/w2d-common.ts";
import { exampleUrl, installBinary, installExample, platformTarget, type Progress, SetupError, unsupportedPlatformMessage } from "../src/w2d-setup.ts";

const USAGE = "Usage: /sleuth-setup [--no-example] [--yes]";
const STATUS_KEY = "sleuth-setup";
const HINT_KEY = "__sleuthPiSetupHintShown";

/** Without a UI (print and json mode) notify shows nothing, so the person reads stderr. */
function tell(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else process.stderr.write(`[sleuth-setup] ${message}\n`);
}

function progress(ctx: ExtensionContext, label: string): Progress {
	let shown = -1;
	return (received, total) => {
		const mb = Math.round(received / 1e6);
		const percent = total ? Math.floor((received / total) * 100) : undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(STATUS_KEY, percent === undefined ? `${label}: ${mb} MB` : `${label}: ${percent}% of ${Math.round(total! / 1e6)} MB`);
		} else if (!ctx.hasUI && percent !== undefined && percent >= shown + 10) {
			shown = percent - (percent % 10);
			process.stderr.write(`[sleuth-setup] ${label}: ${shown}%\n`);
		}
	};
}

async function setupBinary(ctx: ExtensionContext): Promise<boolean> {
	const target = platformTarget();
	if (!target) {
		tell(ctx, unsupportedPlatformMessage(), "error");
		return false;
	}
	const dest = managedBinaryPath();
	tell(ctx, `Checking the latest words_to_data release for ${target}...`);
	try {
		const result = await installBinary(dest, target, progress(ctx, "words_to_data"));
		const what = { installed: "Installed", updated: "Updated to", current: "Already current:" }[result.status];
		tell(ctx, `${what} ${result.version} at ${dest}`);
	} catch (err) {
		tell(ctx, err instanceof SetupError ? err.message : `Download of words_to_data failed: ${String(err)}`, "error");
		return false;
	} finally {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	const active = resolveBinary();
	if (active && active.path !== dest) {
		tell(ctx, `SLEUTH still runs ${active.path} (from ${active.source}), which comes before the setup binary. Unset it to use ${dest}.`, "warning");
	}
	return true;
}

async function setupExample(ctx: ExtensionContext, yes: boolean): Promise<boolean> {
	const dest = exampleDatasetPath();
	if (existsSync(dest)) return true;
	if (!yes) {
		if (!ctx.hasUI) {
			tell(ctx, `The example dataset is a 284 MB download (5.3 GB on disk). Run /sleuth-setup --yes to download it without a prompt, or /sleuth-setup --no-example to skip it.`, "warning");
			return false;
		}
		const ok = await ctx.ui.confirm(
			"Download the example dataset?",
			`SLEUTH downloads ${exampleUrl()} (284 MB) and decompresses it to ${dest} (5.3 GB). This takes a few minutes.`,
		);
		if (!ok) {
			tell(ctx, "No example dataset. Register your own with /dataset <path.sqlite>.");
			return false;
		}
	}
	tell(ctx, `Downloading the example dataset to ${dest}...`);
	try {
		await installExample(dest, progress(ctx, "example dataset"));
	} catch (err) {
		tell(ctx, err instanceof SetupError ? err.message : `Download of the example dataset failed: ${String(err)}`, "error");
		return false;
	} finally {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Once per pi process: /new starts a session but needs no second hint.
		const g = globalThis as Record<string, unknown>;
		if (g[HINT_KEY] || resolveBinary()) return;
		g[HINT_KEY] = true;
		tell(ctx, "SLEUTH found no words_to_data binary. Run /sleuth-setup to download it and the example dataset.", "warning");
	});

	pi.registerCommand("sleuth-setup", {
		description: "Download words_to_data and the example dataset, and open it read-only: /sleuth-setup [--no-example] [--yes]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const unknown = parts.filter((part) => part !== "--no-example" && part !== "--yes");
			if (unknown.length > 0) {
				tell(ctx, unknown.includes("--help") ? USAGE : `Unknown option ${unknown.join(" ")}. ${USAGE}`, unknown.includes("--help") ? "info" : "error");
				return;
			}
			// A failed download still allows the example when another binary is found.
			if (!(await setupBinary(ctx)) && !resolveBinary()) return;
			if (parts.includes("--no-example")) return;
			if (await setupExample(ctx, parts.includes("--yes"))) registerDataset(ctx, exampleDatasetPath(), false);
		},
	});
}
