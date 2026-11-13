import assert from "node:assert/strict";
import { test } from "node:test";
import { DIRECT_LANE, LanePool } from "../src/pool.ts";

const relay = (host: string, port: number) => ({ key: `${host}:${port}`, host, port });

test("lanes are every relay plus the direct connection", () => {
	const pool = new LanePool([relay("1.1.1.1", 1), relay("2.2.2.2", 2)]);
	assert.deepEqual(
		pool.list().map((lane) => lane.key),
		[DIRECT_LANE, "1.1.1.1:1", "2.2.2.2:2"],
	);
});

test("capacity is two per lane per model", async () => {
	const pool = new LanePool([relay("1.1.1.1", 1), relay("2.2.2.2", 2)]);
	const signal = new AbortController().signal;
	const taken = [];
	for (let i = 0; i < 6; i++) {
		const lane = await pool.acquire("Qwen3.8-27B", signal);
		assert.ok(lane, `lane ${i} should be free`);
		taken.push(lane!.key);
	}
	assert.equal(taken.length, 6);
	assert.equal(new Set(taken).size, 3, "each lane used twice");
	const free = pool.snapshot("Qwen3.8-27B").reduce((sum, row) => sum + row.free, 0);
	assert.equal(free, 0);
});

test("buckets are per model", async () => {
	const pool = new LanePool([relay("1.1.1.1", 1)]);
	const signal = new AbortController().signal;
	// Round-robin spreads these over both lanes, one slot each.
	await pool.acquire("gpt-oss-20b", signal);
	await pool.acquire("gpt-oss-20b", signal);
	for (const row of pool.snapshot("gpt-oss-20b")) assert.equal(row.used, 1);
	// A different model has its own buckets.
	assert.equal(
		pool.snapshot("Qwen3.8-27B").reduce((s, r) => s + r.free, 0),
		4,
	);
});

test("release after a 429 puts the slot back", async () => {
	const pool = new LanePool([relay("1.1.1.1", 1)]);
	const signal = new AbortController().signal;
	const before = pool.snapshot("m").reduce((s, r) => s + r.free, 0);
	const lane = await pool.acquire("m", signal);
	assert.ok(lane);
	assert.equal(
		pool.snapshot("m").reduce((s, r) => s + r.free, 0),
		before - 1,
	);
	pool.release(lane!.key, "m");
	assert.equal(
		pool.snapshot("m").reduce((s, r) => s + r.free, 0),
		before,
	);
});

test("prefers lanes without failures", async () => {
	const pool = new LanePool([relay("1.1.1.1", 1), relay("2.2.2.2", 2)]);
	pool.markFailed(DIRECT_LANE);
	const lane = await pool.acquire("m", new AbortController().signal);
	assert.notEqual(lane!.key, DIRECT_LANE);
});

test("acquire aborts instead of waiting forever", async () => {
	const pool = new LanePool([relay("1.1.1.1", 1)]);
	const signal = new AbortController().signal;
	const capacity = pool.list().length * 2;
	for (let i = 0; i < capacity; i++) await pool.acquire("m", signal);
	assert.equal(
		pool.snapshot("m").reduce((s, r) => s + r.free, 0),
		0,
	);

	const controller = new AbortController();
	const pending = pool.acquire("m", controller.signal);
	controller.abort();
	await assert.rejects(pending);
});

test("setRelays keeps buckets for lanes that survive", async () => {
	const pool = new LanePool([relay("1.1.1.1", 1)]);
	await pool.acquire("m", new AbortController().signal);
	pool.setRelays([relay("1.1.1.1", 1)]);
	assert.equal(pool.snapshot("m")[0]!.used, 1);
});
