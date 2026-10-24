/**
 * /sleuth-setup downloads against a local HTTP server, never the network:
 * SLEUTH_RELEASE_URL and SLEUTH_EXAMPLE_URL point it here. The executables are
 * real shell scripts that print a version, as `words_to_data --version` does;
 * with W2D_BIN set, one more test serves the real binary.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";

import { exampleDatasetPath, managedBinaryPath, resolveBinary, setBinaryPath } from "../src/w2d-common.ts";
import { assetName, installBinary, installExample, isNewer, platformTarget, unsupportedPlatformMessage } from "../src/w2d-setup.ts";

const TARGET = "x86_64-unknown-linux-musl";
const ASSET = assetName(TARGET);

function script(version: string): Buffer {
	return Buffer.from(`#!/bin/sh\necho "words_to_data ${version}"\n`);
}

type Route = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Route>();
const hits: string[] = [];
let base = "";
const server = createServer((req, res) => {
	hits.push(req.url ?? "");
	const route = routes.get(req.url ?? "");
	if (route) route(req, res);
	else res.writeHead(404).end("Not Found");
});

function serve(path: string, body: Buffer): void {
	routes.set(path, (_req, res) => res.writeHead(200, { "content-length": body.length }).end(body));
}

/** A fresh pi agent directory (so a fresh managed folder) and HOME per test. */
function freshAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sleuth-setup-"));
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.HOME = dir;
	return dir;
}

before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("maps each supported platform to its release target", () => {
	assert.equal(platformTarget("linux", "x64"), "x86_64-unknown-linux-musl");
	assert.equal(platformTarget("linux", "arm64"), "aarch64-unknown-linux-musl");
	assert.equal(platformTarget("darwin", "arm64"), "aarch64-apple-darwin");
	assert.equal(platformTarget("darwin", "x64"), "x86_64-apple-darwin");
	assert.equal(platformTarget("win32", "x64"), "x86_64-pc-windows-msvc");
	assert.equal(platformTarget("win32", "arm64"), undefined);
	assert.equal(platformTarget("freebsd", "x64"), undefined);
	assert.match(unsupportedPlatformMessage("freebsd", "x64"), /freebsd-x64.*cargo install words-to-data/);
	assert.equal(assetName("x86_64-pc-windows-msvc"), "words_to_data-x86_64-pc-windows-msvc.exe.gz");
	assert.equal(assetName(TARGET), "words_to_data-x86_64-unknown-linux-musl.gz");
});

test("compares a release tag with the installed --version", () => {
	assert.equal(isNewer("v0.4.1", "words_to_data 0.4.0"), true);
	assert.equal(isNewer("v0.4.0", "words_to_data 0.4.0"), false);
	assert.equal(isNewer("v0.4.0", "words_to_data 0.10.0"), false);
	assert.equal(isNewer("v1.0.0", "words_to_data 0.10.0"), true);
});

test("downloads, gunzips and installs an executable binary", async () => {
	freshAgentDir();
	process.env.SLEUTH_RELEASE_URL = `${base}/direct`;
	serve(`/direct/${ASSET}`, gzipSync(script("0.4.1")));
	const dest = managedBinaryPath();
	const result = await installBinary(dest, TARGET);
	assert.deepEqual(result, { status: "installed", version: "words_to_data 0.4.1", tag: undefined });
	assert.equal(statSync(dest).mode & 0o777, 0o755);
	assert.deepEqual(readdirSync(join(dest, "..")), ["words_to_data"], "no temporary file is left");
});

test("skips the download when the installed binary is the release the redirect names", async () => {
	freshAgentDir();
	process.env.SLEUTH_RELEASE_URL = `${base}/latest/download`;
	// GitHub's shape: /releases/latest/download/<asset> → /releases/download/<tag>/<asset>.
	routes.set(`/latest/download/${ASSET}`, (_req, res) => res.writeHead(302, { location: `/download/v0.4.1/${ASSET}` }).end());
	serve(`/download/v0.4.1/${ASSET}`, gzipSync(script("0.4.1")));
	const dest = managedBinaryPath();
	assert.equal((await installBinary(dest, TARGET)).status, "installed");
	hits.length = 0;
	const again = await installBinary(dest, TARGET);
	assert.deepEqual(again, { status: "current", version: "words_to_data 0.4.1", tag: "v0.4.1" });
	assert.deepEqual(hits, [`/latest/download/${ASSET}`], "the file itself is not downloaded again");

	// A newer release replaces it.
	routes.set(`/latest/download/${ASSET}`, (_req, res) => res.writeHead(302, { location: `/download/v0.5.0/${ASSET}` }).end());
	serve(`/download/v0.5.0/${ASSET}`, gzipSync(script("0.5.0")));
	assert.deepEqual(await installBinary(dest, TARGET), { status: "updated", version: "words_to_data 0.5.0", tag: "v0.5.0" });
});

test("says clearly when the latest release has no binary for the platform", async () => {
	freshAgentDir();
	process.env.SLEUTH_RELEASE_URL = `${base}/latest/download`;
	routes.set(`/latest/download/${ASSET}`, (_req, res) => res.writeHead(302, { location: `/download/v0.4.0/${ASSET}` }).end());
	routes.delete(`/download/v0.4.0/${ASSET}`);
	const dest = managedBinaryPath();
	await assert.rejects(installBinary(dest, TARGET), /latest words-to-data release \(v0\.4\.0\) has no binary for x86_64-unknown-linux-musl.*cargo install/s);
	assert.equal(existsSync(dest), false);
});

test("keeps the installed binary when the new file does not run or the download breaks", async () => {
	freshAgentDir();
	process.env.SLEUTH_RELEASE_URL = `${base}/direct`;
	serve(`/direct/${ASSET}`, gzipSync(script("0.4.1")));
	const dest = managedBinaryPath();
	await installBinary(dest, TARGET);
	const good = readFileSync(dest);

	serve(`/direct/${ASSET}`, gzipSync(Buffer.from("not an executable\n")));
	await assert.rejects(installBinary(dest, TARGET), /does not run/);
	assert.deepEqual(readFileSync(dest), good);

	// The connection drops half way through the body.
	const full = gzipSync(script("0.5.0"));
	routes.set(`/direct/${ASSET}`, (req, res) => {
		res.writeHead(200, { "content-length": full.length });
		res.write(full.subarray(0, 10), () => req.socket.destroy());
	});
	await assert.rejects(installBinary(dest, TARGET));
	assert.deepEqual(readFileSync(dest), good);
	assert.deepEqual(readdirSync(join(dest, "..")), ["words_to_data"]);
});

test("installs the real words_to_data binary", { skip: !process.env.W2D_BIN && "set W2D_BIN to serve the real binary" }, async () => {
	freshAgentDir();
	process.env.SLEUTH_RELEASE_URL = `${base}/real`;
	serve(`/real/${ASSET}`, gzipSync(readFileSync(process.env.W2D_BIN!)));
	const result = await installBinary(managedBinaryPath(), TARGET);
	assert.match(result.version, /^words_to_data \d+\.\d+\.\d+/);
});

test("downloads and decompresses the example dataset", async () => {
	const dir = freshAgentDir();
	const source = join(dir, "source.sqlite");
	const db = new DatabaseSync(source);
	db.exec("CREATE TABLE metadata(key TEXT, value TEXT); INSERT INTO metadata VALUES ('name', 'example');");
	db.close();
	const zst = zstdCompressSync(readFileSync(source));
	serve("/assets/example.sqlite.zst", zst);
	process.env.SLEUTH_EXAMPLE_URL = `${base}/assets/example.sqlite.zst`;
	const seen: number[] = [];
	const dest = exampleDatasetPath();
	await installExample(dest, (received, total) => {
		assert.equal(total, zst.length);
		seen.push(received);
	});
	assert.equal(seen.at(-1), zst.length, "progress counts the compressed bytes");
	const copy = new DatabaseSync(dest, { readOnly: true });
	assert.deepEqual({ ...copy.prepare("SELECT value FROM metadata").get() }, { value: "example" });
	copy.close();
	assert.deepEqual(readdirSync(join(dest, "..")), ["example.sqlite"]);
});

test("binary lookup: /dataset --bin, W2D_BIN, the setup binary, then PATH", () => {
	const dir = freshAgentDir();
	const savedPath = process.env.PATH;
	const savedBin = process.env.W2D_BIN;
	try {
		const pathDir = join(dir, "path-bin");
		mkdirSync(pathDir);
		writeFileSync(join(pathDir, "words_to_data"), script("0.3.0"));
		chmodSync(join(pathDir, "words_to_data"), 0o755);
		process.env.PATH = `${pathDir}${delimiter}${savedPath ?? ""}`;
		delete process.env.W2D_BIN;
		setBinaryPath(undefined);
		assert.deepEqual(resolveBinary(), { path: join(pathDir, "words_to_data"), source: "PATH" });

		mkdirSync(join(managedBinaryPath(), ".."), { recursive: true });
		writeFileSync(managedBinaryPath(), script("0.4.1"));
		assert.deepEqual(resolveBinary(), { path: managedBinaryPath(), source: "/sleuth-setup" });

		process.env.W2D_BIN = "/opt/w2d/words_to_data";
		assert.deepEqual(resolveBinary(), { path: "/opt/w2d/words_to_data", source: "W2D_BIN" });

		setBinaryPath("/from/dataset/words_to_data");
		assert.deepEqual(resolveBinary(), { path: "/from/dataset/words_to_data", source: "/dataset --bin" });
	} finally {
		setBinaryPath(undefined);
		process.env.PATH = savedPath;
		if (savedBin === undefined) delete process.env.W2D_BIN;
		else process.env.W2D_BIN = savedBin;
	}
});
