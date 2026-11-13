/**
 * Model catalog. Covers every chat model the endpoint offers for free; the
 * non-chat entries in `/v1/models` (embeddings, TTS, whisper, SDXL, guard
 * classifiers) are out of scope. llama-3-3-70b, qwen-2-5-vl-72b and
 * qwen-3-6-27b were once excluded (10s delay + redirect); retested
 * 2026-11-13 they answer in under a second, so they are in.
 *
 * Pi levels are off, minimal, low, medium, high, xhigh, max. The provider
 * rarely matches them, so every spec maps to a value the provider accepts; a
 * claim Pi cannot honour is left null. Verified against the live endpoint:
 *   gpt-oss-*  : low | medium | high, no 'none', no 'minimal'
 *   Qwen3.8    : none | low | medium | xhigh, 'high' rejected, xhigh is default
 *   Qwen3.6    : none | low | high | xhigh | max, all accepted
 *   Qwen3.5-*  : none | low | medium | high
 *   Mistral, Qwen2.5-VL, Llama: no reasoning_effort at all
 */

export interface ReasoningSpec {
	/** Value sent for each Pi level. null means the level is not offered. */
	map: Record<string, string | null>;
}

export interface ChatModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	reasoning?: ReasoningSpec;
}

const GPT_OSS: ReasoningSpec = {
	map: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
		max: "high",
	},
};

const QWEN38: ReasoningSpec = {
	// xhigh is this model's default effort. 'high' is rejected, so the closest
	// honest value for Pi's high and xhigh is the default itself.
	map: {
		off: "none",
		minimal: "none",
		low: "low",
		medium: "medium",
		high: "xhigh",
		xhigh: "xhigh",
		max: "xhigh",
	},
};

const QWEN36: ReasoningSpec = {
	// Every value verified live except 'medium', assumed from the family.
	map: {
		off: "none",
		minimal: "none",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
};

const QWEN35: ReasoningSpec = {
	map: {
		off: "none",
		minimal: "none",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
		max: "high",
	},
};

export const MODELS: readonly ChatModel[] = [
	{
		id: "gpt-oss-20b",
		name: "GPT-OSS 20B",
		contextWindow: 131_072,
		maxTokens: 131_072,
		vision: false,
		reasoning: GPT_OSS,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		contextWindow: 131_072,
		maxTokens: 131_072,
		vision: false,
		reasoning: GPT_OSS,
	},
	{
		id: "Qwen3.8-27B",
		name: "Qwen3.8 27B",
		contextWindow: 262_144,
		maxTokens: 262_144,
		vision: true,
		reasoning: QWEN38,
	},
	{
		id: "Qwen3.6-27B",
		name: "Qwen3.6 27B",
		contextWindow: 262_144,
		maxTokens: 262_144,
		vision: true,
		reasoning: QWEN36,
	},
	{
		id: "Qwen3.5-9B",
		name: "Qwen3.5 9B",
		contextWindow: 262_144,
		maxTokens: 262_144,
		vision: true,
		reasoning: QWEN35,
	},
	{
		id: "Qwen3.5-397B-A17B",
		name: "Qwen3.5 397B A17B",
		contextWindow: 262_144,
		maxTokens: 262_144,
		vision: true,
		reasoning: QWEN35,
	},
	{
		id: "Mistral-Small-3.2-24B-Instruct-2506",
		name: "Mistral Small 3.2 24B",
		contextWindow: 131_072,
		maxTokens: 131_072,
		vision: true,
	},
	{
		id: "Qwen2.5-VL-72B-Instruct",
		name: "Qwen2.5 VL 72B",
		contextWindow: 32_768,
		maxTokens: 32_768,
		vision: true,
	},
	{
		id: "Meta-Llama-3_3-70B-Instruct",
		name: "Meta Llama 3.3 70B",
		contextWindow: 131_072,
		maxTokens: 131_072,
		vision: false,
	},
];

/** Pi's `thinkingLevelMap`, or undefined for a model without reasoning. */
export function thinkingLevelMap(model: ChatModel): Record<string, string | null> | undefined {
	return model.reasoning?.map;
}
