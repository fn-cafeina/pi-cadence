import assert from "node:assert/strict";
import test from "node:test";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ENDPOINT } from "../src/endpoint.ts";
import { LanePool } from "../src/pool.ts";
import { Dispatchers } from "../src/probe.ts";
import { type ProviderDeps, streamOnce } from "../src/provider.ts";

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

const startEvent = (): AssistantMessageEvent => ({ type: "start" }) as AssistantMessageEvent;

const doneEvent = (): AssistantMessageEvent =>
	({ type: "done", message: { timestamp: 0 } }) as AssistantMessageEvent;

const textDelta = (): AssistantMessageEvent =>
	({ type: "text_delta", contentIndex: 0, delta: "x" }) as AssistantMessageEvent;

/** Deps whose streamSimple replays the scripted events, one stream per attempt. */
function depsFor(scripts: AssistantMessageEvent[][]) {
	const pool = new LanePool([relay("1.1.1.1:1", "1.1.1.1", 1), relay("2.2.2.2:2", "2.2.2.2", 2)]);
	const counter = { n: 0 };
	const streamSimple: ProviderDeps["streamSimple"] = () => {
		const events = scripts[counter.n] ?? [];
		counter.n += 1;
		return (async function* () {
			yield* events;
		})() as unknown as AssistantMessageEventStream;
	};
	const deps: ProviderDeps = { pool, dispatchers: new Dispatchers(), streamSimple };
	return { deps, pool, counter };
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
