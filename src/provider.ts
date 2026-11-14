/**
 * Provider registration. Service-specific data comes from `ENDPOINT`
 * in `src/endpoint.ts`; only the transport changes.
 *
 * Each request takes a slot from a lane (one per relay plus the direct
 * connection, each with its own rate-limit bucket) and streams through Pi's
 * own `openai-completions` implementation with only the transport changed.
 * Every event is forwarded untouched; errors are Pi's to handle.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENDPOINT } from "./endpoint.ts";
import { type ChatModel, thinkingLevelMap } from "./models.ts";
import type { Lane, LanePool } from "./pool.ts";
import { type Dispatchers, describe } from "./probe.ts";

const PROVIDER_ID = ENDPOINT.id;
/** Pi refuses to send a request without a key; the anonymous tier ignores it. */
const FAKE_KEY = "unused";

export interface ProviderDeps {
	pool: LanePool;
	dispatchers: Dispatchers;
	streamSimple: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
}

/** Strip anything that would authenticate us: the anonymous tier 403s on it. */
function anonymousFetch(lane: Lane, dispatchers: Dispatchers): typeof fetch {
	const dispatcher = lane.relay ? dispatchers.get(lane.relay) : undefined;
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.delete("authorization");
		return fetch(
			input,
			dispatcher ? ({ ...init, headers, dispatcher } as RequestInit) : { ...init, headers },
		);
	};
}

function catalogModel(entry: ChatModel): Model<Api> {
	return {
		id: entry.id,
		name: entry.name,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: ENDPOINT.baseUrl,
		reasoning: entry.reasoning !== undefined,
		thinkingLevelMap: thinkingLevelMap(entry),
		input: entry.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
	};
}

function emptyMessage(
	model: Model<Api>,
	message: string,
	stopReason: "error" | "aborted",
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/**
 * Streams one request on one lane, forwarding every event untouched. The lane
 * keeps its slot for the rest of the window either way, so when Pi retries a
 * failure the next acquire prefers a lane that has spent less.
 */
export async function streamOnce(
	deps: ProviderDeps,
	out: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): Promise<void> {
	const signal = options?.signal;
	if (signal?.aborted) {
		out.push({
			type: "error",
			reason: "aborted",
			error: emptyMessage(model, "aborted", "aborted"),
		});
		out.end();
		return;
	}

	const lane = await deps.pool.acquire(model.id, signal ?? new AbortController().signal);
	if (!lane) {
		const lanes = deps.pool.list().length;
		out.push({
			type: "error",
			reason: "error",
			error: emptyMessage(
				model,
				`all ${lanes} lanes at limit; next slot >65s. /cadence add for more lanes.`,
				"error",
			),
		});
		out.end();
		return;
	}

	const source = deps.streamSimple(model, context, {
		...options,
		apiKey: FAKE_KEY,
		fetch: anonymousFetch(lane, deps.dispatchers),
	});
	for await (const event of source) out.push(event);
	out.end();
}

function streamOnLane(
	deps: ProviderDeps,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void streamOnce(deps, out, model, context, options).catch((error) => {
		out.push({
			type: "error",
			reason: "error",
			error: emptyMessage(model, describe(error), "error"),
		});
		out.end();
	});
	return out;
}

export function registerProvider(pi: ExtensionAPI, deps: ProviderDeps): void {
	const provider = createProvider({
		id: PROVIDER_ID,
		name: ENDPOINT.name,
		baseUrl: ENDPOINT.baseUrl,
		auth: {
			apiKey: {
				name: ENDPOINT.authName,
				resolve: async () => ({ auth: { apiKey: FAKE_KEY }, source: "anonymous" }),
			},
		},
		models: ENDPOINT.models.map(catalogModel),
		api: {
			"openai-completions": {
				// `stream` is required by the ProviderStreams contract; both entry
				// points share the same forwarding.
				stream: (model, context, options) => streamOnLane(deps, model, context, options),
				streamSimple: (model, context, options) => streamOnLane(deps, model, context, options),
			},
		},
	});
	pi.registerProvider(provider);
}
