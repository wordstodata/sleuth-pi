/**
 * The download steps of /sleuth-setup: the words_to_data release binary for
 * this platform, and the example dataset. No Rust, curl, zstd or tar: fetch
 * downloads, node:zlib decompresses, and each file is written under a temporary
 * name and renamed only when it is complete, so an interrupted download never
 * leaves a broken file where SLEUTH looks.
 */

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { createGunzip, createZstdDecompress } from "node:zlib";

export const RELEASE_URL_ENV = "SLEUTH_RELEASE_URL";
export const EXAMPLE_URL_ENV = "SLEUTH_EXAMPLE_URL";

const DEFAULT_RELEASE_URL = "https://github.com/wordstodata/words-to-data/releases/latest/download";
const DEFAULT_EXAMPLE_URL = "https://wordstodata.com/assets/wordstodata-example.sqlite.zst";

export class SetupError extends Error {}

/** The base URL of the release assets: `<base>/words_to_data-<target>.gz`. */
export function releaseBaseUrl(): string {
	return (process.env[RELEASE_URL_ENV] || DEFAULT_RELEASE_URL).replace(/\/+$/, "");
}

export function exampleUrl(): string {
	return process.env[EXAMPLE_URL_ENV] || DEFAULT_EXAMPLE_URL;
}

/** The release target for a platform, as the words-to-data release workflow names it. */
const TARGETS: Record<string, string> = {
	"linux-x64": "x86_64-unknown-linux-musl",
	"linux-arm64": "aarch64-unknown-linux-musl",
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"win32-x64": "x86_64-pc-windows-msvc",
};

export function platformTarget(platform: string = process.platform, arch: string = process.arch): string | undefined {
	return TARGETS[`${platform}-${arch}`];
}

export function unsupportedPlatformMessage(platform: string = process.platform, arch: string = process.arch): string {
	return `words-to-data has no release binary for ${platform}-${arch}. Build it from source with \`cargo install words-to-data\` (it needs Rust: https://rustup.rs), then set W2D_BIN or put words_to_data on PATH.`;
}

export function assetName(target: string): string {
	return target.includes("windows") ? `words_to_data-${target}.exe.gz` : `words_to_data-${target}.gz`;
}

/** "words_to_data 0.4.1" or "v0.4.1" → [0, 4, 1]; undefined when there is no version. */
export function parseVersion(text: string): [number, number, number] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True when `candidate` is a newer version than `installed`. */
export function isNewer(candidate: string, installed: string): boolean {
	const a = parseVersion(candidate);
	const b = parseVersion(installed);
	if (!a || !b) return true;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return false;
}

/** The first line of `<bin> --version`, or undefined when the binary does not run. */
export async function binaryVersion(bin: string): Promise<string | undefined> {
	try {
		const { stdout } = await promisify(execFile)(bin, ["--version"], { timeout: 30_000 });
		return stdout.trim().split("\n")[0] || undefined;
	} catch {
		return undefined;
	}
}

export type Progress = (received: number, total: number | undefined) => void;

/**
 * Stream a response body through a decompressor into `dest`. The file is
 * written as `<dest>.download` and renamed at the end; `prepare` runs on the
 * complete temporary file first (chmod, a check that it runs), and a throw
 * there removes it, so a bad file never replaces a good one.
 */
async function writeDecompressed(
	response: Response,
	dest: string,
	decompress: Transform,
	onProgress?: Progress,
	prepare?: (tmp: string) => Promise<void>,
): Promise<void> {
	if (!response.body) throw new SetupError(`${response.url} sent no body.`);
	const total = Number(response.headers.get("content-length")) || undefined;
	let received = 0;
	const count = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			received += chunk.length;
			onProgress?.(received, total);
			done(null, chunk);
		},
	});
	const tmp = `${dest}.download`;
	await mkdir(dirname(dest), { recursive: true });
	try {
		await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), count, decompress, createWriteStream(tmp));
		await prepare?.(tmp);
		await rename(tmp, dest);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

export interface BinaryResult {
	/** "installed", "updated", or "current" when the installed binary is already the latest. */
	status: "installed" | "updated" | "current";
	version: string;
	/** The release tag, when the server redirected to one (GitHub does). */
	tag?: string | undefined;
}

/**
 * Install or update the words_to_data binary at `dest` from `<base>/<asset>`.
 *
 * GitHub answers `/releases/latest/download/<asset>` with a redirect to
 * `/releases/download/<tag>/<asset>`, so the tag is known before the download:
 * when the installed binary is that version already, nothing is downloaded. A
 * server that answers 200 directly has no tag, so its file is downloaded and
 * compared by `--version`.
 */
export async function installBinary(dest: string, target: string, onProgress?: Progress): Promise<BinaryResult> {
	const url = `${releaseBaseUrl()}/${assetName(target)}`;
	const installed = await binaryVersion(dest);
	let response = await fetch(url, { redirect: "manual" });
	let tag: string | undefined;
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location) throw new SetupError(`${url} redirected with no Location.`);
		const next = new URL(location, url);
		tag = /\/download\/([^/]+)\//.exec(next.pathname)?.[1];
		if (installed && tag && !isNewer(tag, installed)) return { status: "current", version: installed, tag };
		response = await fetch(next);
	}
	if (response.status === 404) {
		await response.body?.cancel();
		throw new SetupError(
			`The latest words-to-data release${tag ? ` (${tag})` : ""} has no binary for ${target}: ${url} was not found. Releases with binaries start after words-to-data 0.4.0. Until then, build from source with \`cargo install --git https://github.com/wordstodata/words-to-data\` and set W2D_BIN or put words_to_data on PATH.`,
		);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new SetupError(`Download of ${url} failed: HTTP ${response.status}.`);
	}
	let version = "";
	await writeDecompressed(response, dest, createGunzip(), onProgress, async (tmp) => {
		await chmod(tmp, 0o755);
		const ran = await binaryVersion(tmp);
		if (!ran) throw new SetupError(`The file from ${url} does not run (\`--version\` failed), so it was not installed.`);
		version = ran;
	});
	return { status: installed ? (installed === version ? "current" : "updated") : "installed", version, tag };
}

/** Download the example dataset (zstd) and decompress it to `dest`. */
export async function installExample(dest: string, onProgress?: Progress): Promise<void> {
	const url = exampleUrl();
	const response = await fetch(url);
	if (!response.ok) {
		await response.body?.cancel();
		throw new SetupError(`Download of ${url} failed: HTTP ${response.status}.`);
	}
	await writeDecompressed(response, dest, createZstdDecompress(), onProgress);
}
