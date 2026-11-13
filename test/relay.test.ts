import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRelayBlock, parseRelayLine, relayLabel, relayUrl } from "../src/relay.ts";

test("parses the webshare host:port:user:pass form", () => {
	assert.deepEqual(parseRelayLine("45.38.107.97:6014:user1:pass1"), {
		host: "45.38.107.97",
		port: 6014,
		user: "user1",
		pass: "pass1",
	});
});

test("parses the url form with credentials", () => {
	assert.deepEqual(parseRelayLine("http://user1:pass1@45.38.107.97:6014"), {
		host: "45.38.107.97",
		port: 6014,
		user: "user1",
		pass: "pass1",
	});
});

test("parses a bare host:port and defaults the scheme port", () => {
	assert.deepEqual(parseRelayLine("proxy.example.com:8080"), {
		host: "proxy.example.com",
		port: 8080,
	});
	assert.deepEqual(parseRelayLine("http://proxy.example.com"), {
		host: "proxy.example.com",
		port: 80,
		user: undefined,
		pass: undefined,
	});
});

test("ignores blanks and comments", () => {
	assert.equal(parseRelayLine("   "), null);
	assert.equal(parseRelayLine("# mi relay"), null);
});

test("rejects malformed lines instead of guessing", () => {
	assert.throws(() => parseRelayLine("solo-una-cosa"), /unrecognized format/);
	assert.throws(() => parseRelayLine("host:99999"), /invalid port/);
	assert.throws(() => parseRelayLine("http://"), /invalid URL/);
});

test("keeps good lines and reports bad ones from a pasted block", () => {
	const { relays, errors } = parseRelayBlock(
		["1.1.1.1:1:u:p", "basura", "", "2.2.2.2:2:u:p"].join("\n"),
	);
	assert.equal(relays.length, 2);
	assert.equal(errors.length, 1);
});

test("labels never leak credentials but urls carry them", () => {
	const relay = { host: "1.2.3.4", port: 80, user: "u", pass: "secret" };
	assert.equal(relayLabel(relay), "***@1.2.3.4:80");
	assert.ok(relayUrl(relay).includes("secret"));
	assert.equal(relayLabel(relay).includes("secret"), false);
});
