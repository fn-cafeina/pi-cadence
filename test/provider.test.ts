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
import { LanePool } from "../src/pool.ts";
import { Dispatchers } from "../src/probe.ts";
import { type ProviderDeps, streamWithRotation } from "../src/provider.ts";
import { ENDPOINT } from "../src/endpoint.ts";

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

function failures(pool: LanePool, laneKey: string): number {
	return pool.list().find((lane) => lane.key === laneKey)?.failures ?? -1;
}

test("rotates to another lane on a 429 before content", async () => {
	const { deps, pool, counter } = depsFor([
		[errorEvent("429 status code (no body)")],
		[startEvent(), doneEvent()],
	]);
	const out = createAssistantMessageEventStream();
	await streamWithRotation(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 2);
	assert.ok(events.some((event) => event.type === "start"));
	assert.ok(!events.some((event) => event.type === "error"));
	// The 429 lane gave its slot back and was marked failing; the winner kept its slot.
	assert.equal(failures(pool, "direct"), 1);
	assert.equal(used(pool, "direct", model.id), 0);
	assert.equal(failures(pool, "1.1.1.1:1"), 0);
	assert.equal(used(pool, "1.1.1.1:1", model.id), 1);
});

test("rotates on a transport failure before content and releases the slot", async () => {
	const { deps, pool, counter } = depsFor([
		[errorEvent("fetch failed: connect ECONNREFUSED 1.1.1.1:6014")],
		[startEvent(), doneEvent()],
	]);
	const out = createAssistantMessageEventStream();
	await streamWithRotation(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 2);
	assert.ok(events.some((event) => event.type === "start"));
	assert.equal(used(pool, "direct", model.id), 0);
	assert.equal(failures(pool, "direct"), 1);
});

test("rotates on a stream cut before its first chunk", async () => {
	const { deps, pool, counter } = depsFor([
		[startEvent(), errorEvent("Stream ended without finish_reason")],
		[startEvent(), textDelta(), doneEvent()],
	]);
	const out = createAssistantMessageEventStream();
	await streamWithRotation(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 2);
	assert.equal(events.length, 3);
	assert.equal(events[0]!.type, "start");
	assert.equal(events[1]!.type, "text_delta");
	assert.equal(events[2]!.type, "done");
	// The dead lane gave its slot back and was marked failing; the winner kept its slot.
	assert.equal(used(pool, "direct", model.id), 0);
	assert.equal(failures(pool, "direct"), 1);
	assert.equal(used(pool, "1.1.1.1:1", model.id), 1);
});

test("does not rotate once real content has been emitted", async () => {
	const { deps, counter } = depsFor([[startEvent(), textDelta(), errorEvent("socket closed")]]);
	const out = createAssistantMessageEventStream();
	await streamWithRotation(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 1);
	assert.equal(events.length, 3);
	assert.equal(events[0]!.type, "start");
	assert.equal(events[1]!.type, "text_delta");
	assert.equal(events[2]!.type, "error");
});

test("gives up after six attempts with the last error", async () => {
	const failing = [errorEvent("fetch failed: connect ECONNREFUSED 1.1.1.1:6014")];
	const { deps, counter } = depsFor([failing, failing, failing, failing, failing, failing]);
	const out = createAssistantMessageEventStream();
	await streamWithRotation(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 6);
	assert.equal(events.length, 1);
	const last = events[0]!;
	assert.equal(last.type, "error");
	if (last.type === "error") assert.match(last.error.errorMessage ?? "", /all 3 lanes failed/);
});

test("reports aborted when the signal is already aborted", async () => {
	const { deps, counter } = depsFor([]);
	const out = createAssistantMessageEventStream();
	const controller = new AbortController();
	controller.abort();
	await streamWithRotation(deps, out, model, context, { signal: controller.signal });
	const events = await drain(out);

	assert.equal(counter.n, 0);
	assert.equal(events.length, 1);
	const last = events[0]!;
	assert.equal(last.type, "error");
	if (last.type === "error") assert.equal(last.error.errorMessage, "aborted");
});
