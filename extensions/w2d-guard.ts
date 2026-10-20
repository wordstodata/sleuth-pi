/**
 * Dataset registration and the write gate.
 *
 * /dataset <path> [--write] registers the dataset every w2d_* tool reads and,
 * with --write, grants this session permission for the two write commands
 * (w2d_settle --verdict and w2d_link_amendment). Without --write every write
 * is refused: the playbook's "never write to a dataset you were not told you
 * may change" is enforced in code, not left to the prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	expandPath,
	getDatasetPath,
	setBinaryPath,
	setDatasetPath,
	setWriteGrant,
	W2dError,
	W2D_DATASET_ENV,
} from "../src/w2d-common.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// A fresh session never carries a write grant, even across /new.
		setWriteGrant(false);
		if (ctx.mode === "tui") {
			const dataset = process.env[W2D_DATASET_ENV];
			ctx.ui.setStatus("sleuth-dataset", dataset ? `w2d: ${dataset.split("/").pop()}` : "w2d: no dataset (/dataset)");
		}
	});

	pi.registerCommand("dataset", {
		description: "Register a words_to_data dataset: /dataset <path.sqlite> [--write] [--bin <path>]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const target = parts[0];
			if (!target || target === "--help") {
				ctx.ui.notify("Usage: /dataset <path.sqlite> [--write] [--bin <path>]", "info");
				return;
			}
			const write = parts.includes("--write");
			const binIdx = parts.indexOf("--bin");
			const binArg = parts[binIdx + 1];
			if (binIdx >= 0 && binArg) setBinaryPath(expandPath(binArg, ctx.cwd));

			// Validate now: a path that does not exist fails here, not on first tool call.
			const path = expandPath(target, ctx.cwd);
			try {
				setDatasetPath(path);
				// getDatasetPath re-checks existence and throws W2dError if missing.
				getDatasetPath(ctx.cwd);
			} catch (err) {
				setDatasetPath(undefined);
				ctx.ui.notify(err instanceof W2dError ? err.message : String(err), "error");
				return;
			}
			setWriteGrant(write);
			if (ctx.mode === "tui") {
				ctx.ui.setStatus("sleuth-dataset", `w2d: ${path.split("/").pop()}${write ? " (WRITE)" : ""}`);
			}
			ctx.ui.notify(
				`Dataset registered: ${path}\nWrite access: ${write ? "GRANTED for this session (settle --verdict, link-amendment)" : "read-only"}`,
				write ? "warning" : "info",
			);
		},
	});
}
