import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
	loadRelays,
	mergeRelays,
	reloadIfChanged,
	removeRelay,
	saveRelays,
	updateRelays,
} from "../src/store.ts";

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

test("loadRelays drops entries without a valid host or port", () => {
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			relays: [{ host: "1.1.1.1", port: 1 }, { host: "", port: 443 }, { host: "2.2.2.2" }, null],
		}),
	);
	assert.deepEqual(
		loadRelays(path).map((entry) => entry.key),
		["1.1.1.1:1"],
	);
});

test("saveRelays moves a corrupt file aside instead of overwriting it", () => {
	writeFileSync(path, "not json");
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1)], path);
	assert.equal(readFileSync(`${path}.bak`, "utf8"), "not json");
	assert.deepEqual(loadRelays(path), [
		{ key: "1.1.1.1:1", host: "1.1.1.1", port: 1, user: undefined, pass: undefined },
	]);
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

test("updateRelays sees what another process saved just before", () => {
	// Process B saves between process A's read and write; the transform runs
	// after the re-read, so B's relay survives A's add.
	rmSync(path, { force: true });
	saveRelays([relay("2.2.2.2:2", "2.2.2.2", 2)], path);
	updateRelays((current) => [...current, relay("1.1.1.1:1", "1.1.1.1", 1)], path);
	assert.deepEqual(
		loadRelays(path).map((entry) => entry.key),
		["2.2.2.2:2", "1.1.1.1:1"],
	);
});

test("updateRelays removes without resurrecting", () => {
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1), relay("2.2.2.2:2", "2.2.2.2", 2)], path);
	updateRelays((current) => current.filter((entry) => entry.key !== "1.1.1.1:1"), path);
	assert.deepEqual(
		loadRelays(path).map((entry) => entry.key),
		["2.2.2.2:2"],
	);
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

test("reloadIfChanged reports changes and stays quiet when the file is untouched", () => {
	rmSync(path, { force: true });
	assert.equal(reloadIfChanged(path), undefined);
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1)], path);
	assert.deepEqual(
		reloadIfChanged(path)!.map((entry) => entry.key),
		["1.1.1.1:1"],
	);
	assert.equal(reloadIfChanged(path), undefined);
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1), relay("2.2.2.2:2", "2.2.2.2", 2)], path);
	assert.equal(reloadIfChanged(path)!.length, 2);
});

test("reloadIfChanged reports a deleted file as an empty list", () => {
	saveRelays([relay("1.1.1.1:1", "1.1.1.1", 1)], path);
	reloadIfChanged(path);
	rmSync(path);
	assert.deepEqual(reloadIfChanged(path), []);
});
