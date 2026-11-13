/**
 * Relay parsing. One relay per line, host first. Accepted forms:
 *
 *   host:port:user:pass      Webshare panel export
 *   http://user:pass@host:port
 *   host:port                no auth
 */

export interface Relay {
	/** Stable key: host:port. */
	key: string;
	host: string;
	port: number;
	user?: string;
	pass?: string;
}

export type RelayInput = { host: string; port: number; user?: string; pass?: string };

export function relayKey(host: string, port: number): string {
	return `${host}:${port}`;
}

function parsePort(raw: string, line: string): number {
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`invalid port in "${line}"`);
	}
	return port;
}

/** Parse one line. Returns null for blanks and comments. Throws on anything malformed. */
export function parseRelayLine(input: string): RelayInput | null {
	const line = input.trim();
	if (!line || line.startsWith("#")) return null;

	if (line.includes("://")) {
		let url: URL;
		try {
			url = new URL(line);
		} catch {
			throw new Error(`invalid URL: "${line}"`);
		}
		const port = url.port ? parsePort(url.port, line) : url.protocol === "https:" ? 443 : 80;
		return {
			host: url.hostname,
			port,
			user: url.username ? decodeURIComponent(url.username) : undefined,
			pass: url.password ? decodeURIComponent(url.password) : undefined,
		};
	}

	const parts = line.split(":");
	if (parts.length === 4) {
		const [host, port, user, pass] = parts;
		if (!host) throw new Error(`empty host in "${line}"`);
		return { host, port: parsePort(port, line), user, pass };
	}
	if (parts.length === 2) {
		const [host, port] = parts;
		if (!host) throw new Error(`empty host in "${line}"`);
		return { host, port: parsePort(port, line) };
	}
	throw new Error(`unrecognized format: "${line}"`);
}

/** Parse a pasted block. Bad lines are reported, good ones survive. */
export function parseRelayBlock(text: string): { relays: RelayInput[]; errors: string[] } {
	const relays: RelayInput[] = [];
	const errors: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		try {
			const relay = parseRelayLine(raw);
			if (relay) relays.push(relay);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(raw));
		}
	}
	return { relays, errors };
}

export function toRelay({ host, port, user, pass }: RelayInput): Relay {
	return { key: relayKey(host, port), host, port, user, pass };
}

export function relayUrl({ host, port, user, pass }: RelayInput | Relay): string {
	const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? "")}@` : "";
	return `http://${auth}${host}:${port}`;
}

/** Never show credentials in the transcript. */
export function relayLabel({ host, port, user }: RelayInput | Relay): string {
	return `${user ? "***@" : ""}${host}:${port}`;
}
