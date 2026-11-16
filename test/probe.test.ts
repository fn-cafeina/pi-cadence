import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "../src/probe.ts";

test("describe labels aborts as timeout", () => {
	const abort = new Error("aborted");
	abort.name = "AbortError";
	assert.equal(describe(abort), "timeout");
});

test("describe maps errno codes to the friendly text", () => {
	const refused = new Error("fetch failed");
	(refused as { cause?: unknown }).cause = { code: "ECONNREFUSED", message: "raw" };
	assert.equal(describe(refused), "connection refused");

	const notFound = new Error("fetch failed");
	(notFound as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "raw" };
	assert.equal(describe(notFound), "host not found");
});

test("describe falls back to the raw message and stringifies non-errors", () => {
	assert.equal(describe(new Error("plain")), "plain");
	assert.equal(describe("stringy"), "stringy");
});
