/**
 * Relay probing. The models endpoint costs no rate limit (checked live: no
 * ratelimit headers, six requests in a row all 200), so testing is free.
 */

import { ProxyAgent } from "undici";
import { ENDPOINT } from "./endpoint.ts";
import { type Relay, relayUrl } from "./relay.ts";

const PROBE_TIMEOUT_MS = 8_000;
const IP_ECHO = "https://api.ipify.org";

export interface Probe {
	ok: boolean;
	ms: number;
	/** Egress IP when the echo service answered. */
	ip?: string;
	error?: string;
}

/**
 * ProxyAgent instances are the expensive part, so they are cached per relay:
 * one per relay for the process lifetime, reused by requests and probes.
 */
export class Dispatchers {
	private readonly agents = new Map<string, ProxyAgent>();

	get(relay: Relay): ProxyAgent {
		let agent = this.agents.get(relay.key);
		if (!agent) {
			agent = new ProxyAgent(relayUrl(relay));
			this.agents.set(relay.key, agent);
		}
		return agent;
	}

	drop(key: string): void {
		const agent = this.agents.get(key);
		if (!agent) return;
		this.agents.delete(key);
		void agent.close().catch(() => {});
	}

	async closeAll(): Promise<void> {
		const agents = [...this.agents.values()];
		this.agents.clear();
		await Promise.all(agents.map((agent) => agent.close().catch(() => {})));
	}
}

async function timed<T>(
	work: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; ms: number }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const start = performance.now();
	try {
		const value = await work(controller.signal);
		return { value, ms: performance.now() - start };
	} finally {
		clearTimeout(timer);
	}
}

/** Check that a relay reaches the provider. Never throws. */
export async function probe(relay: Relay, dispatchers: Dispatchers): Promise<Probe> {
	try {
		const { value, ms } = await timed(async (signal) => {
			return await fetch(ENDPOINT.baseUrl + ENDPOINT.probePath, {
				dispatcher: dispatchers.get(relay),
				signal,
			} as RequestInit);
		});
		if (!value.ok) return { ok: false, ms: round(ms), error: `HTTP ${value.status}` };
		return { ok: true, ms: round(ms) };
	} catch (error) {
		return { ok: false, ms: 0, error: describe(error) };
	}
}

/** Egress IP of a relay, to catch two relays sharing one rate-limit bucket. */
export async function egressIp(
	relay: Relay,
	dispatchers: Dispatchers,
): Promise<string | undefined> {
	try {
		const { value } = await timed(async (signal) => {
			return await fetch(IP_ECHO, { dispatcher: dispatchers.get(relay), signal } as RequestInit);
		});
		if (!value.ok) return undefined;
		const ip = (await value.text()).trim();
		return ip || undefined;
	} catch {
		return undefined;
	}
}

/** Errno codes a user recognizes better than the raw string. */
const FRIENDLY_CODES: Record<string, string> = {
	ECONNREFUSED: "connection refused",
	ETIMEDOUT: "timed out",
	ECONNRESET: "connection reset",
	ENOTFOUND: "host not found",
	EAI_AGAIN: "host not found",
};

export function describe(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "AbortError") return "timeout";
		const cause = (error as { cause?: { code?: string; message?: string } }).cause;
		const code = cause?.code;
		return (code ? FRIENDLY_CODES[code] : undefined) ?? code ?? cause?.message ?? error.message;
	}
	return String(error);
}

function round(ms: number): number {
	return Math.round(ms);
}
