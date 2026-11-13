/**
 * `/cadence` command group. Subcommands are parsed from the raw argument string
 * Pi hands to the handler, so `/cadence test 1` and `/cadence test` both work.
 *
 * Every subcommand prints one notification: action (if any) plus the current
 * state, so consecutive commands replace each other in the transcript instead
 * of stacking. `info` is dim and replaceable; `warning`/`error` stack, so
 * they are reserved for things worth keeping (partial or total failure).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LIMIT } from "./bucket.ts";
import type { LanePool } from "./pool.ts";
import { type Dispatchers, egressIp, probe } from "./probe.ts";
import { ACTIVE_PROVIDER } from "./providers/ovh.ts";
import { parseRelayBlock, type Relay, relayLabel, toRelay } from "./relay.ts";
import { loadRelays, mergeRelays, removeRelay, saveRelays } from "./store.ts";

export interface CommandDeps {
	pool: LanePool;
	dispatchers: Dispatchers;
}

const USAGE = [
	"/cadence              state",
	"/cadence list          relays",
	"/cadence add           paste relays",
	"/cadence remove        remove relay",
	"/cadence test [n]      probe relays",
].join("\n");

function currentRelays(pool: LanePool): Relay[] {
	return pool
		.list()
		.filter((lane) => lane.relay !== undefined)
		.map((lane) => lane.relay as Relay);
}

function formatMs(ms: number): string {
	return ms > 0 ? `${(ms / 1000).toFixed(2)}s` : "-";
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Capacity only, shared by every subcommand. */
function capacityLine(pool: LanePool): string {
	const lanes = pool.list().length;
	return `${plural(lanes, "lane")} · ${lanes * LIMIT} rpm/model`;
}

/** Requests spent on one model across all lanes. */
function usage(pool: LanePool, modelId: string): number {
	return pool.snapshot(modelId).reduce((sum, row) => sum + row.used, 0);
}

/** Free slots of one model as `free/total`. */
function quotaLine(pool: LanePool, modelId: string): string {
	const total = pool.list().length * LIMIT;
	return `${total - usage(pool, modelId)}/${total}`;
}

/** Canonical status block. `modelId` (the active model, when it is ours)
 *  goes first, because it is the number the user is spending. */
export function formatStatus(pool: LanePool, modelId?: string): string {
	const lines = [
		modelId ? `${modelId} ${quotaLine(pool, modelId)} · ${capacityLine(pool)}` : capacityLine(pool),
	];

	// Free quota is identical on every model until something is spent, so only
	// list models that actually carry usage.
	for (const entry of ACTIVE_PROVIDER.models) {
		if (entry.id === modelId || usage(pool, entry.id) === 0) continue;
		lines.push(`${entry.id} ${quotaLine(pool, entry.id)}`);
	}

	const failing = pool.list().filter((lane) => lane.failures > 0).length;
	if (failing > 0) lines.push(`${plural(failing, "relay")} failing · /cadence test`);
	if (modelId && usage(pool, modelId) >= pool.list().length * LIMIT)
		lines.push(`next slot in ${waitText(pool, modelId)}`);
	if (pool.list().length === 1) lines.push("add relays with /cadence add");

	return lines.join("\n");
}

/** Seconds until the active model frees a slot. Buckets reset within 60s,
 *  so >65s is defensive only. */
function waitText(pool: LanePool, modelId: string): string {
	const soonest = Math.min(...pool.snapshot(modelId).map((row) => row.waitMs));
	if (!Number.isFinite(soonest)) return "unknown";
	return `${Math.max(1, Math.ceil(soonest / 1000))}s`;
}

/** The model the user is actually spending, if it is one of ours. */
function activeModelId(ctx: ExtensionCommandContext): string | undefined {
	return ctx.model?.provider === ACTIVE_PROVIDER.id ? ctx.model.id : undefined;
}

function listRelays(pool: LanePool): string {
	const relays = currentRelays(pool);
	if (relays.length === 0) {
		return "no relays · add with /cadence add";
	}
	const lanes = pool.list();
	const lines = [capacityLine(pool)];
	for (const [index, relay] of relays.entries()) {
		const failures = lanes.find((lane) => lane.key === relay.key)?.failures ?? 0;
		const warn = failures > 0 ? `  · ${failures} failures` : "";
		lines.push(`  ${String(index + 1).padStart(2)}  ${relayLabel(relay)}${warn}`);
	}
	return lines.join("\n");
}

async function addRelays(deps: CommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const pasted = await ctx.ui.editor(
		"Relays, one per line: host:port, host:port:user:pass, or http://user:pass@host:port",
		"",
	);
	if (pasted === undefined) return;

	const { relays: parsed, errors } = parseRelayBlock(pasted);
	if (parsed.length === 0) {
		const lines =
			errors.length > 0
				? [`${plural(errors.length, "line")} invalid`, ...errors.map((error) => `  ${error}`)]
				: ["nothing pasted"];
		ctx.ui.notify(lines.join("\n"), "error");
		return;
	}

	const existing = loadRelays();
	const { added, duplicates } = mergeRelays(existing, parsed.map(toRelay));
	if (added.length === 0) {
		ctx.ui.notify(plural(duplicates.length, "dupe"), "info");
		return;
	}

	// Probe in parallel: ten relays cost one second, not ten.
	const probes = await Promise.all(added.map((relay) => probe(relay, deps.dispatchers)));
	const alive = added.filter((_, index) => probes[index].ok);
	const dead = added
		.map((relay, index) => ({ relay, result: probes[index] }))
		.filter((entry) => !entry.result.ok);

	const { relays: next } = mergeRelays(existing, alive);
	saveRelays(next);
	deps.pool.setRelays(next);

	const summary = [
		alive.length > 0 ? `${alive.length} saved` : "",
		dead.length > 0 ? `${dead.length} dropped` : "",
		duplicates.length > 0 ? plural(duplicates.length, "dupe") : "",
	].filter((part) => part !== "");

	const lines = [summary.join(", ")];
	for (const { relay, result } of dead) lines.push(`  ${relayLabel(relay)} · ${result.error}`);
	for (const error of errors) lines.push(`  ${error}`);
	lines.push(capacityLine(deps.pool));

	ctx.ui.notify(lines.join("\n"), dead.length > 0 || errors.length > 0 ? "warning" : "info");
}

async function removeRelays(deps: CommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const relays = loadRelays();
	if (relays.length === 0) {
		ctx.ui.notify("no relays to remove", "info");
		return;
	}
	const labels = relays.map((relay) => relayLabel(relay));
	const choice = await ctx.ui.select("Remove which relay?", labels);
	if (choice === undefined) return;
	const relay = relays[labels.indexOf(choice)];
	if (!relay) return;
	if (!(await ctx.ui.confirm("Remove relay", `${relayLabel(relay)}?`))) return;

	const next = removeRelay(relays, relay.key);
	saveRelays(next);
	deps.pool.setRelays(next);
	deps.dispatchers.drop(relay.key);
	ctx.ui.notify(`removed ${relayLabel(relay)}\n${capacityLine(deps.pool)}`, "info");
}

function parseIndex(raw: string, count: number): { index: number } | { error: string } {
	const index = Number(raw);
	if (!Number.isInteger(index)) return { error: `"${raw}" is not a number` };
	if (index < 1 || index > count) return { error: `no relay ${index} (have ${count})` };
	return { index };
}

async function testRelays(
	deps: CommandDeps,
	ctx: ExtensionCommandContext,
	arg: string,
): Promise<void> {
	const relays = currentRelays(deps.pool);
	if (relays.length === 0) {
		ctx.ui.notify("no relays · add with /cadence add", "info");
		return;
	}

	let targets = relays;
	const raw = arg.trim();
	if (raw) {
		const parsed = parseIndex(raw, relays.length);
		if ("error" in parsed) {
			ctx.ui.notify(parsed.error, "error");
			return;
		}
		targets = [relays[parsed.index - 1]];
	}

	// Probe and IP lookup run together per relay, so a relay costs one round trip.
	const results = await Promise.all(
		targets.map(async (relay) => {
			const [result, ip] = await Promise.all([
				probe(relay, deps.dispatchers),
				egressIp(relay, deps.dispatchers),
			]);
			return { relay, probe: result, ip };
		}),
	);

	// Two relays behind one egress IP share a bucket, so the lane count overstates
	// capacity. Only then is the IP worth printing.
	const byIp = new Map<string, string[]>();
	for (const { relay, ip } of results) {
		if (!ip) continue;
		byIp.set(ip, [...(byIp.get(ip) ?? []), relay.key]);
	}
	const collisions = [...byIp.entries()].filter(([, keys]) => keys.length > 1);
	const shared = new Set(collisions.flatMap(([, keys]) => keys));

	const lines: string[] = [];
	for (const { relay, probe: result, ip } of results) {
		const position = String(relays.indexOf(relay) + 1);
		const state = result.ok ? "ok  " : "FAIL";
		const detail = result.ok ? formatMs(result.ms) : result.error;
		const suffix = ip && shared.has(relay.key) ? `  ip ${ip}` : "";
		lines.push(
			`  ${position.padStart(2)}  ${relayLabel(relay).padEnd(28)} ${state}  ${detail}${suffix}`,
		);
	}

	const ok = results.filter((entry) => entry.probe.ok).length;
	lines.push(`${ok} of ${results.length} up`);
	for (const [ip, keys] of collisions) {
		lines.push(`${keys.join(" and ")} share egress ip ${ip}, same bucket`);
	}

	for (const { relay, probe: result } of results) {
		if (result.ok) deps.pool.markOk(relay.key);
		else deps.pool.markFailed(relay.key);
	}

	const level = ok === results.length ? "info" : ok === 0 ? "error" : "warning";
	ctx.ui.notify(lines.join("\n"), level);
}

export async function handleCadence(
	args: string,
	ctx: ExtensionCommandContext,
	deps: CommandDeps,
): Promise<void> {
	const text = args.trim();
	if (!text) {
		ctx.ui.notify(formatStatus(deps.pool, activeModelId(ctx)), "info");
		return;
	}

	const [sub, ...rest] = text.split(/\s+/);
	switch (sub) {
		case "list":
			ctx.ui.notify(listRelays(deps.pool), "info");
			return;
		case "add":
			await addRelays(deps, ctx);
			return;
		case "remove":
			await removeRelays(deps, ctx);
			return;
		case "test":
			await testRelays(deps, ctx, rest.join(" "));
			return;
		case "help":
			ctx.ui.notify(USAGE, "info");
			return;
		default:
			ctx.ui.notify(`unknown subcommand "${sub}"\n\n${USAGE}`, "error");
	}
}
