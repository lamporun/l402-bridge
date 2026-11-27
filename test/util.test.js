// @ts-check
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readBounded, readJson } from "../src/util.js";

/**
 * serve runs a one-route server and returns its URL and a close function.
 *
 * @param {http.RequestListener} handler
 */
async function serve(handler) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
	const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve(undefined));
			}),
	};
}

test("a small body is read and parsed", async () => {
	const s = await serve((req, res) => res.end(JSON.stringify({ ok: true })));
	try {
		assert.deepEqual(await readJson(await fetch(s.url), 1024), { ok: true });
	} finally {
		await s.close();
	}
});

test("a declared oversized body is refused without reading it", async () => {
	let written = 0;
	const s = await serve((req, res) => {
		res.writeHead(200, { "content-length": String(64 * 1024 * 1024) });
		const chunk = Buffer.alloc(64 * 1024, 0x20);
		const pump = () => {
			while (written < 64 * 1024 * 1024 && res.write(chunk)) written += chunk.length;
			if (written < 64 * 1024 * 1024) res.once("drain", pump);
		};
		res.on("error", () => {});
		pump();
	});
	try {
		assert.equal(await readBounded(await fetch(s.url), 64 * 1024), null);
		await assert.rejects(readJson(await fetch(s.url), 64 * 1024), /larger than 65,536 bytes/);
		assert.ok(written < 32 * 1024 * 1024, `the server got to write ${written} bytes`);
	} finally {
		await s.close();
	}
});

test("an endless chunked body is cancelled once past the limit", async () => {
	let written = 0;
	let closed = false;
	const s = await serve((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		const chunk = Buffer.alloc(16 * 1024, 0x20);
		res.on("close", () => (closed = true));
		res.on("error", () => {});
		const pump = () => {
			while (!closed && written < 256 * 1024 * 1024 && res.write(chunk)) written += chunk.length;
			if (!closed && written < 256 * 1024 * 1024) res.once("drain", pump);
		};
		pump();
	});
	try {
		assert.equal(await readBounded(await fetch(s.url), 64 * 1024), null);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(closed, "the connection was closed");
		assert.ok(written < 32 * 1024 * 1024, `the server got to write ${written} bytes`);
	} finally {
		await s.close();
	}
});

test("a compressed body is limited by its decompressed size", async () => {
	const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024, 0x20));
	assert.ok(bomb.length < 64 * 1024);
	const s = await serve((req, res) => {
		res.writeHead(200, { "content-encoding": "gzip", "content-length": String(bomb.length) });
		res.end(bomb);
	});
	try {
		assert.equal(await readBounded(await fetch(s.url), 1024 * 1024), null);
	} finally {
		await s.close();
	}
});

test("a body that trickles in is cut off by the request's deadline", async () => {
	const s = await serve((req, res) => {
		res.writeHead(200);
		const timer = setInterval(() => res.write(" "), 20);
		res.on("close", () => clearInterval(timer));
	});
	try {
		const res = await fetch(s.url, { signal: AbortSignal.timeout(300) });
		await assert.rejects(readBounded(res, 1024 * 1024));
	} finally {
		await s.close();
	}
});
