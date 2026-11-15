/**
 * Relay list persistence. Lives next to the other Pi config so it follows
 * PI_CODING_AGENT_DIR, mode 0600 because it holds relay credentials.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Relay, toRelay } from "./relay.ts";

interface StoredFile {
	version: 1;
	relays: Array<{ host: string; port: number; user?: string; pass?: string }>;
}

export function relaysPath(): string {
	return join(getAgentDir(), "cadence.json");
}

export function loadRelays(path = relaysPath()): Relay[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<StoredFile>;
		// Hand-edited files may carry broken entries; drop them rather than
		// build a lane that fails on every request.
		return (parsed.relays ?? []).filter(isStoredRelay).map(toRelay);
	} catch {
		// A corrupt file must not take Pi down; the user can re-add relays.
		return [];
	}
}

export function saveRelays(relays: readonly Relay[], path = relaysPath()): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	backUpCorrupt(path);
	const body: StoredFile = {
		version: 1,
		relays: relays.map(({ host, port, user, pass }) => ({ host, port, user, pass })),
	};
	// Write then rename so a crash mid-write cannot truncate the list.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

let lastRaw = "";

/**
 * Relays from disk if the file changed since the last check, else undefined.
 * Other Pi processes share the file but not each other's pool.
 */
export function reloadIfChanged(path = relaysPath()): Relay[] | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = "";
		else throw error;
	}
	if (raw === lastRaw) return undefined;
	lastRaw = raw;
	return loadRelays(path);
}

/** Merge parsed input into the list, dropping duplicates by host:port. */
export function mergeRelays(
	existing: readonly Relay[],
	incoming: readonly Relay[],
): { relays: Relay[]; added: Relay[]; duplicates: Relay[] } {
	const seen = new Set(existing.map((relay) => relay.key));
	const relays = [...existing];
	const added: Relay[] = [];
	const duplicates: Relay[] = [];
	for (const relay of incoming) {
		if (seen.has(relay.key)) {
			duplicates.push(relay);
			continue;
		}
		seen.add(relay.key);
		relays.push(relay);
		added.push(relay);
	}
	return { relays, added, duplicates };
}

export function removeRelay(relays: readonly Relay[], key: string): Relay[] {
	return relays.filter((relay) => relay.key !== key);
}

function isStoredRelay(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const { host, port } = entry as { host?: unknown; port?: unknown };
	return (
		typeof host === "string" &&
		typeof port === "number" &&
		Number.isInteger(port) &&
		port > 0 &&
		port <= 65535
	);
}

/** A corrupt list is not an empty list: move it aside so a save cannot replace it. */
function backUpCorrupt(path: string): void {
	try {
		JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		renameSync(path, `${path}.bak`);
	}
}
