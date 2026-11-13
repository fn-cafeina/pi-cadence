/**
 * One rate-limit bucket per (lane, model). The provider counts the limit per
 * IP and per model, so lanes never share a bucket when their egress IPs differ.
 */

import { ACTIVE_PROVIDER } from "./providers/ovh.ts";

export const WINDOW_MS = ACTIVE_PROVIDER.windowMs;
export const LIMIT = ACTIVE_PROVIDER.limit;

export class Bucket {
	private hits: number[] = [];

	count(now: number): number {
		this.prune(now);
		return this.hits.length;
	}

	/** Take a slot if one is free. Returns the window position, or undefined when full. */
	tryTake(now: number): number | undefined {
		this.prune(now);
		if (this.hits.length >= LIMIT) return undefined;
		this.hits.push(now);
		return this.hits.length - 1;
	}

	/** Give back the oldest slot. Only for a request the provider rejected as rate limited. */
	release(): void {
		this.hits.shift();
	}

	/** Milliseconds until the oldest slot frees, 0 when a slot is already free. */
	waitMs(now: number): number {
		this.prune(now);
		if (this.hits.length < LIMIT) return 0;
		return Math.max(0, (this.hits[0] ?? now) + WINDOW_MS - now);
	}

	private prune(now: number): void {
		const cutoff = now - WINDOW_MS;
		while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
	}
}
