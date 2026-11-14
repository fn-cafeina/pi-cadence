import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, mock } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatStatus, handleCadence } from "../src/cadence.ts";
import { LanePool } from "../src/pool.ts";
import { Dispatchers } from "../src/probe.ts";
import { loadRelays, saveRelays } from "../src/store.ts";

// Handler tests point the relay store at a temp dir, never ~/.pi/agent.
const agentDir = mkdtempSync(join(tmpdir(), "pi-cadence-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});

type Note = [string, string?];

/** Command context whose ui only records notifications. */
function commandCtx(notes: Note[]): ExtensionCommandContext {
	return {
		model: undefined,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notes.push([message, type]);
			},
			editor: async () => undefined,
			select: async () => undefined,
			confirm: async () => false,
		},
	} as unknown as ExtensionCommandContext;
}

const relay = (key: string, host: string, port: number) => ({ key, host, port });

test("status is the capacity line plus a hint when there are no relays", () => {
	const pool = new LanePool([]);
	assert.equal(formatStatus(pool), "1 lane · 2 rpm/model\nadd relays with /cadence add");
});

test("status leads with the active model quota", () => {
	const pool = new LanePool([{ key: "h:1", host: "h", port: 1 }]);
	assert.equal(formatStatus(pool, "Qwen3.8-27B"), "Qwen3.8-27B 4/4 · 2 lanes · 4 rpm/model");
});

test("status lists other in-use models, failing relays and the next slot", async () => {
	const pool = new LanePool([]);
	const signal = new AbortController().signal;
	for (let i = 0; i < 2; i++) await pool.acquire("Qwen3.8-27B", signal);
	await pool.acquire("gpt-oss-20b", signal);
	pool.markFailed("direct");

	const status = formatStatus(pool, "Qwen3.8-27B");
	assert.ok(status.startsWith("Qwen3.8-27B 0/2 · 1 lane · 2 rpm/model"));
	assert.ok(status.includes("gpt-oss-20b 1/2"));
	assert.ok(status.includes("1 relay failing · /cadence test"));
	assert.ok(status.includes("next slot in "));
});

test("remove by number deletes that relay and updates the pool", async () => {
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1), relay("2.2.2.2:2", "2.2.2.2", 2)]);
	const pool = new LanePool(loadRelays());
	await handleCadence("remove 1", commandCtx([]), { pool, dispatchers: new Dispatchers() });
	assert.deepEqual(
		loadRelays().map((entry) => entry.key),
		["2.2.2.2:2"],
	);
	assert.deepEqual(
		pool.list().map((lane) => lane.key),
		["direct", "2.2.2.2:2"],
	);
});

test("remove out of range errors and leaves the file untouched", async () => {
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1)]);
	const pool = new LanePool(loadRelays());
	const notes: Note[] = [];
	await handleCadence("remove 9", commandCtx(notes), { pool, dispatchers: new Dispatchers() });
	assert.equal(notes.length, 1);
	assert.match(notes[0][0], /no relay 9/);
	assert.equal(notes[0][1], "error");
	assert.deepEqual(
		loadRelays().map((entry) => entry.key),
		["1.1.1.1:1"],
	);
});

test("add with an argument saves the relay without the editor", async () => {
	saveRelays([]);
	mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));
	const pool = new LanePool([]);
	await handleCadence("add 1.2.3.4:6014", commandCtx([]), { pool, dispatchers: new Dispatchers() });
	mock.restoreAll();
	assert.deepEqual(
		loadRelays().map((entry) => entry.key),
		["1.2.3.4:6014"],
	);
});

test("add without an argument opens the editor; canceling saves nothing", async () => {
	saveRelays([]);
	const pool = new LanePool([]);
	await handleCadence("add", commandCtx([]), { pool, dispatchers: new Dispatchers() });
	assert.deepEqual(loadRelays(), []);
});
