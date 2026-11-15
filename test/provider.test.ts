import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENDPOINT } from "../src/endpoint.ts";
import { LanePool } from "../src/pool.ts";
import { Dispatchers } from "../src/probe.ts";
import { type ProviderDeps, registerProvider, streamOnce } from "../src/provider.ts";

const model = {
	id: ENDPOINT.models[0]!.id,
	name: ENDPOINT.models[0]!.name,
	api: "openai-completions" as const,
	provider: ENDPOINT.id,
} as unknown as Model<Api>;

const context = [] as unknown as TranscriptContext;

const relay = (key: string, host: string, port: number) => ({ key, host, port });

const errorEvent = (message: string): AssistantMessageEvent =>
	({
		type: "error",
		reason: "error",
		error: { errorMessage: message },
	}) as AssistantMessageEvent;

const abortedEvent = (): AssistantMessageEvent =>
	({ type: "error", reason: "aborted", error: {} }) as AssistantMessageEvent;

const startEvent = (): AssistantMessageEvent => ({ type: "start" }) as AssistantMessageEvent;

const doneEvent = (): AssistantMessageEvent =>
	({ type: "done", message: { timestamp: 0 } }) as AssistantMessageEvent;

const textDelta = (): AssistantMessageEvent =>
	({ type: "text_delta", contentIndex: 0, delta: "x" }) as AssistantMessageEvent;

/** Deps whose streamSimple replays the scripted events, one stream per attempt. */
function depsFor(scripts: AssistantMessageEvent[][]): {
	deps: ProviderDeps;
	pool: LanePool;
	counter: { n: number };
	lastOptions: { current?: SimpleStreamOptions };
} {
	const pool = new LanePool([relay("1.1.1.1:1", "1.1.1.1", 1), relay("2.2.2.2:2", "2.2.2.2", 2)]);
	const counter = { n: 0 };
	const lastOptions: { current?: SimpleStreamOptions } = {};
	const streamSimple: ProviderDeps["streamSimple"] = (_model, _context, options) => {
		lastOptions.current = options;
		const events = scripts[counter.n] ?? [];
		counter.n += 1;
		return (async function* () {
			yield* events;
		})() as unknown as AssistantMessageEventStream;
	};
	const deps: ProviderDeps = { pool, dispatchers: new Dispatchers(), streamSimple };
	return { deps, pool, counter, lastOptions };
}

async function drain(out: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of out) events.push(event);
	return events;
}

function used(pool: LanePool, laneKey: string, modelId: string): number {
	return pool.snapshot(modelId).find((row) => row.lane.key === laneKey)?.used ?? -1;
}

test("forwards every event untouched and keeps the slot", async () => {
	const { deps, pool, counter } = depsFor([[startEvent(), textDelta(), doneEvent()]]);
	const out = createAssistantMessageEventStream();
	await streamOnce(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 1);
	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_delta", "done"],
	);
	assert.equal(used(pool, "direct", model.id), 1);
});

test("forwards an error untouched, without retrying or refunding the slot", async () => {
	const { deps, pool, counter } = depsFor([
		[startEvent(), errorEvent("Stream ended without finish_reason")],
	]);
	const out = createAssistantMessageEventStream();
	await streamOnce(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 1);
	assert.deepEqual(
		events.map((event) => event.type),
		["start", "error"],
	);
	// The slot stays spent for the rest of the window, so the next acquire
	// prefers a lane that has spent less.
	assert.equal(used(pool, "direct", model.id), 1);
	assert.equal(used(pool, "1.1.1.1:1", model.id), 0);
});

test("reports aborted when the signal is already aborted", async () => {
	const { deps, counter } = depsFor([]);
	const out = createAssistantMessageEventStream();
	const controller = new AbortController();
	controller.abort();
	await streamOnce(deps, out, model, context, { signal: controller.signal });
	const events = await drain(out);

	assert.equal(counter.n, 0);
	assert.equal(events.length, 1);
	const last = events[0]!;
	assert.equal(last.type, "error");
	if (last.type === "error") assert.equal(last.error.errorMessage, "aborted");
});

test("marks the lane failed on stream errors and clears it on completion", async () => {
	let now = 1_000_000;
	const pool = new LanePool([], {
		now: () => now,
		sleep: (ms: number) => {
			now += ms;
			return Promise.resolve();
		},
	});
	const scripts = [
		[startEvent(), errorEvent("boom")],
		[startEvent(), doneEvent()],
		[startEvent(), abortedEvent()],
	];
	let n = 0;
	const deps: ProviderDeps = {
		pool,
		dispatchers: new Dispatchers(),
		streamSimple: () =>
			(async function* () {
				const events = scripts[n++] ?? [];
				yield* events;
			})() as unknown as AssistantMessageEventStream,
	};
	for (const want of [1, 0, 0]) {
		const out = createAssistantMessageEventStream();
		await streamOnce(deps, out, model, context);
		await drain(out);
		assert.equal(pool.list()[0]!.failures, want);
	}
});

type StreamFn = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

test("labels a mid-wait abort as aborted, not timeout", async () => {
	const { deps, pool } = depsFor([]);
	// Fill every lane so the stream parks in the wait loop.
	for (let i = 0; i < pool.list().length * 2; i++) {
		await pool.acquire(model.id, new AbortController().signal);
	}

	let streamSimple: StreamFn | undefined;
	registerProvider(
		{
			registerProvider: (provider: { streamSimple: StreamFn }) => {
				streamSimple = provider.streamSimple;
			},
		} as unknown as ExtensionAPI,
		deps,
	);
	assert.ok(streamSimple);

	const controller = new AbortController();
	const out = streamSimple(model, context, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();

	const events = await drain(out);
	const last = events[events.length - 1]!;
	assert.equal(last.type, "error");
	if (last.type === "error") {
		assert.equal(last.error.errorMessage, "aborted");
		assert.equal(last.error.stopReason, "aborted");
	}
});

test("strips the authorization header before the request leaves", async () => {
	const { deps, lastOptions } = depsFor([[startEvent(), doneEvent()]]);
	const out = createAssistantMessageEventStream();
	await streamOnce(deps, out, model, context);
	await drain(out);

	const fetcher = (lastOptions.current ?? {}) as { fetch?: typeof fetch };
	assert.ok(fetcher.fetch, "streamSimple must receive the custom fetch");
	const seen: RequestInit[] = [];
	mock.method(globalThis, "fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
		seen.push(init ?? {});
		return Promise.resolve(new Response("", { status: 200 }));
	});
	await fetcher.fetch!("https://example.invalid/v1/chat", {
		headers: { authorization: "Bearer unused" },
	});
	mock.restoreAll();

	const headers = seen[0]!.headers;
	assert.ok(headers instanceof Headers);
	assert.equal(headers.has("authorization"), false);
});
