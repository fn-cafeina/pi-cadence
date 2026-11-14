import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { loadRelays, mergeRelays, removeRelay, saveRelays } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-cadence-store-"));
const path = join(dir, "cadence.json");
after(() => rmSync(dir, { recursive: true, force: true }));

const relay = (key: string, host: string, port: number) => ({ key, host, port });

test("loadRelays returns [] when the file does not exist", () => {
	assert.deepEqual(loadRelays(path), []);
});

test("loadRelays returns [] for a corrupt file instead of throwing", () => {
	writeFileSync(path, "not json");
	assert.deepEqual(loadRelays(path), []);
});

test("saveRelays and loadRelays round-trip including credentials", () => {
	const relays = [
		relay("1.1.1.1:1", "1.1.1.1", 1),
		{ key: "2.2.2.2:2", host: "2.2.2.2", port: 2, user: "u", pass: "secret" },
	];
	saveRelays(relays, path);
	assert.deepEqual(loadRelays(path), [
		{ key: "1.1.1.1:1", host: "1.1.1.1", port: 1, user: undefined, pass: undefined },
		{ key: "2.2.2.2:2", host: "2.2.2.2", port: 2, user: "u", pass: "secret" },
	]);
});

test("saveRelays writes the file with mode 0600", () => {
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1)], path);
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("mergeRelays dedupes by host:port", () => {
	const existing = [relay("1.1.1.1:1", "1.1.1.1", 1)];
	const { relays, added, duplicates } = mergeRelays(existing, [
		relay("1.1.1.1:1", "1.1.1.1", 1),
		relay("2.2.2.2:2", "2.2.2.2", 2),
	]);
	assert.equal(relays.length, 2);
	assert.deepEqual(
		added.map((entry) => entry.key),
		["2.2.2.2:2"],
	);
	assert.deepEqual(
		duplicates.map((entry) => entry.key),
		["1.1.1.1:1"],
	);
});

test("removeRelay drops the matching key", () => {
	const relays = [relay("1.1.1.1:1", "1.1.1.1", 1), relay("2.2.2.2:2", "2.2.2.2", 2)];
	assert.deepEqual(
		removeRelay(relays, "2.2.2.2:2").map((entry) => entry.key),
		["1.1.1.1:1"],
	);
});
