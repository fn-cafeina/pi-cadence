/**
 * Lane pool: every relay plus the direct connection, each with its own
 * per-model bucket. The provider counts the limit per IP and per model, so
 * lanes add up (e.g. 10 relays + direct = 11 lanes x 2 req/min = 22 req/min per model).
 */

import { Bucket, LIMIT } from "./bucket.ts";
import type { Relay } from "./relay.ts";

export const DIRECT_LANE = "direct";

export interface Lane {
	key: string;
	/** undefined for the direct connection. */
	relay?: Relay;
	/** Consecutive failures, used to prefer healthy lanes. */
	failures: number;
	lastUsed: number;
}

interface LaneState {
	buckets: Map<string, Bucket>;
}

/**
 * Buckets live per (lane, model) because the limit is per model. Waiting is
 * capped so a provider with a window longer than MAX_WAIT_MS cannot hang a
 * turn forever.
 */
export const MAX_WAIT_MS = 65_000;

export class LanePool {
	private lanes: Lane[];
	private readonly state = new Map<string, LaneState>();

	constructor(relays: readonly Relay[] = []) {
		this.lanes = buildLanes(relays);
	}

	list(): readonly Lane[] {
		return this.lanes;
	}

	setRelays(relays: readonly Relay[]): void {
		const failures = new Map(this.lanes.map((lane) => [lane.key, lane.failures]));
		this.lanes = buildLanes(relays);
		for (const lane of this.lanes) lane.failures = failures.get(lane.key) ?? 0;
		for (const key of [...this.state.keys()]) {
			if (!this.lanes.some((entry) => entry.key === key)) this.state.delete(key);
		}
	}

	/** Free capacity on every lane for one model, and the soonest reset. */
	snapshot(
		modelId: string,
		now = Date.now(),
	): { lane: Lane; used: number; free: number; waitMs: number }[] {
		return this.lanes.map((lane) => {
			const bucket = this.bucket(lane.key, modelId);
			return {
				lane,
				used: bucket.count(now),
				free: Math.max(0, LIMIT - bucket.count(now)),
				waitMs: bucket.waitMs(now),
			};
		});
	}

	/** Mark a lane as failed so the next pick prefers a different one. */
	markFailed(key: string): void {
		const lane = this.lanes.find((entry) => entry.key === key);
		if (lane) lane.failures += 1;
	}

	markOk(key: string): void {
		const lane = this.lanes.find((entry) => entry.key === key);
		if (lane) lane.failures = 0;
	}

	/**
	 * Reserve the next slot, waiting for a window when every lane is full.
	 * Returns undefined when the wait exceeds MAX_WAIT_MS or the signal aborts.
	 */
	async acquire(modelId: string, signal: AbortSignal): Promise<Lane | undefined> {
		for (;;) {
			signal.throwIfAborted();
			const now = Date.now();
			const candidates = this.snapshot(modelId, now);
			const ready = candidates
				.filter((entry) => entry.free > 0)
				.sort(
					(a, b) =>
						a.lane.failures - b.lane.failures ||
						a.used - b.used ||
						a.lane.lastUsed - b.lane.lastUsed,
				);

			const pick = ready.find(
				(entry) => this.bucket(entry.lane.key, modelId).tryTake(now) !== undefined,
			);
			if (pick) {
				pick.lane.lastUsed = now;
				return pick.lane;
			}

			const soonest = Math.min(...candidates.map((entry) => entry.waitMs));
			if (!Number.isFinite(soonest) || soonest > MAX_WAIT_MS) return undefined;
			await this.sleep(soonest + 50, signal);
		}
	}

	private bucket(laneKey: string, modelId: string): Bucket {
		let entry = this.state.get(laneKey);
		if (!entry) {
			entry = { buckets: new Map() };
			this.state.set(laneKey, entry);
		}
		let bucket = entry.buckets.get(modelId);
		if (!bucket) {
			bucket = new Bucket();
			entry.buckets.set(modelId, bucket);
		}
		return bucket;
	}

	private sleep(ms: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("aborted"));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function buildLanes(relays: readonly Relay[]): Lane[] {
	const lanes: Lane[] = [{ key: DIRECT_LANE, failures: 0, lastUsed: 0 }];
	for (const relay of relays) {
		lanes.push({ key: relay.key, relay, failures: 0, lastUsed: 0 });
	}
	return lanes;
}
