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

import { expandPath, registerDataset, setBinaryPath, setWriteGrant, W2D_DATASET_ENV } from "../src/w2d-common.ts";

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

			registerDataset(ctx, target, write);
		},
	});
}
