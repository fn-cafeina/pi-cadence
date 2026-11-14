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
import {
	isRateLimited,
	isRetryableTransport,
	type ProviderDeps,
	streamWithRotation,
} from "../src/provider.ts";
import { ACTIVE_PROVIDER } from "../src/providers/ovh.ts";

const model = {
	id: ACTIVE_PROVIDER.models[0]!.id,
	name: ACTIVE_PROVIDER.models[0]!.name,
	api: "openai-completions" as const,
	provider: ACTIVE_PROVIDER.id,
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
		[startEvent()],
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
		[startEvent()],
	]);
	const out = createAssistantMessageEventStream();
	await streamWithRotation(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 2);
	assert.ok(events.some((event) => event.type === "start"));
	assert.equal(used(pool, "direct", model.id), 0);
	assert.equal(failures(pool, "direct"), 1);
});

test("does not rotate once the stream has started", async () => {
	const { deps, counter } = depsFor([[startEvent(), errorEvent("socket closed")]]);
	const out = createAssistantMessageEventStream();
	await streamWithRotation(deps, out, model, context);
	const events = await drain(out);

	assert.equal(counter.n, 1);
	assert.equal(events.length, 2);
	assert.equal(events[0]!.type, "start");
	assert.equal(events[1]!.type, "error");
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

test("isRateLimited catches the 429 shapes", () => {
	assert.ok(isRateLimited("429 status code (no body)"));
	assert.ok(isRateLimited('429: {"error":{"message":"Rate limit exceeded"}}'));
	assert.ok(isRateLimited("Rate limit exceeded"));
	assert.ok(!isRateLimited("400 bad request"));
});

test("isRetryableTransport catches transport shapes only", () => {
	assert.ok(isRetryableTransport("fetch failed: connect ECONNREFUSED 1.1.1.1:6014"));
	assert.ok(isRetryableTransport("Request timed out."));
	assert.ok(!isRetryableTransport("429 status code (no body)"));
	assert.ok(!isRetryableTransport("Request was aborted."));
});
