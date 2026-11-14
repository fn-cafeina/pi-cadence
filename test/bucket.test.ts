import assert from "node:assert/strict";
import { test } from "node:test";
import { Bucket, WINDOW_MS } from "../src/bucket.ts";

test("allows exactly LIMIT requests per window", () => {
	const bucket = new Bucket();
	const t0 = 1_000_000;
	assert.equal(bucket.tryTake(t0), 0);
	assert.equal(bucket.tryTake(t0 + 1), 1);
	assert.equal(bucket.tryTake(t0 + 2), undefined);
});

test("frees a slot once the oldest window expires", () => {
	const bucket = new Bucket();
	const t0 = 1_000_000;
	bucket.tryTake(t0);
	bucket.tryTake(t0 + 10);
	// Both slots busy until the first one ages out.
	assert.equal(bucket.waitMs(t0 + 20), WINDOW_MS - 20);
	// Exactly at the window edge the first slot is free again.
	assert.equal(bucket.waitMs(t0 + WINDOW_MS), 0);
	assert.ok(bucket.tryTake(t0 + WINDOW_MS) !== undefined);
	// The second slot is still held until its own window expires.
	assert.equal(bucket.count(t0 + WINDOW_MS), 2);
});
