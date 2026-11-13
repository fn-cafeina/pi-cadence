import assert from "node:assert/strict";
import test from "node:test";

import { formatStatus } from "../src/cadence.ts";
import { LanePool } from "../src/pool.ts";

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
