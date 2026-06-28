import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { fetchJson } from "./http.js";
import { hyperApiBaseUrl, hyperExtensionDir } from "./hyper.js";
import { parseSchema } from "./schema.js";

const MODEL_FETCH_TIMEOUT_MS = 10_000;

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

const HyperModelBaseFields = {
	id: Type.String({ minLength: 1 }),
	object: Type.Literal("model"),
	created: Type.Integer({ minimum: 0 }),
	owned_by: Type.String({ minLength: 1 }),
	display_name: Type.String({ minLength: 1 }),
	supports_reasoning: Type.Boolean(),
	supports_attachments: Type.Boolean(),
	context_window: Type.Integer({ minimum: 1 }),
	max_output_tokens: Type.Integer({ minimum: 1 }),
};

const HyperModelSchema = Type.Union([
	Type.Object(
		{
			...HyperModelBaseFields,
			supports_reasoning_effort: Type.Literal(true),
			reasoning_effort_levels: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
			}),
			default_reasoning_effort: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...HyperModelBaseFields,
			supports_reasoning_effort: Type.Literal(false),
		},
		{ additionalProperties: false },
	),
]);

const ModelPayloadSchema = Type.Object(
	{
		object: Type.Literal("list"),
		data: Type.Array(HyperModelSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

type HyperModel = Static<typeof HyperModelSchema>;

function modelCachePath(): string {
	return path.join(hyperExtensionDir(), "models.json");
}

function toProviderModel(model: HyperModel): ProviderModelConfig {
	const input: ProviderModelConfig["input"] = model.supports_attachments ? ["text", "image"] : ["text"];
	const thinkingLevelMap = model.supports_reasoning_effort
		? buildThinkingLevelMap(model.reasoning_effort_levels)
		: undefined;

	return {
		id: model.id,
		name: model.display_name,
		reasoning: model.supports_reasoning,
		thinkingLevelMap,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.context_window,
		maxTokens: model.max_output_tokens,
		compat: {
			supportsStore: false,
			supportsReasoningEffort: model.supports_reasoning_effort,
			maxTokensField: "max_tokens",
		},
	};
}

function buildThinkingLevelMap(levels: string[]): ThinkingLevelMap | undefined {
	if (levels.length === 0) return undefined;
	const availableLevels = new Set<string>(levels);
	const result: ThinkingLevelMap = {
		off: availableLevels.has("off") ? "off" : null,
	};
	for (const level of PI_THINKING_LEVELS) {
		result[level] = availableLevels.has(level) ? level : null;
	}
	return result;
}

async function fetchModelPayload(): Promise<unknown> {
	return fetchJson(`${hyperApiBaseUrl()}/models`, {
		timeoutMs: MODEL_FETCH_TIMEOUT_MS,
	});
}

function readCachedModelPayload(): unknown | undefined {
	const cachePath = modelCachePath();
	if (!existsSync(cachePath)) return undefined;
	try {
		return JSON.parse(readFileSync(cachePath, "utf-8"));
	} catch (err) {
		console.error(`Failed to read Hyper model cache at ${cachePath}: ${String(err)}`);
		return undefined;
	}
}

function writeCachedModelPayload(payload: unknown): void {
	try {
		mkdirSync(hyperExtensionDir(), { recursive: true });
		writeFileSync(modelCachePath(), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	} catch (err) {
		console.error(`Failed to write Hyper model cache: ${String(err)}`);
	}
}

export async function loadModels(): Promise<ProviderModelConfig[]> {
	try {
		const payload = await fetchModelPayload();
		const models = parseSchema(ModelPayloadSchema, payload, "Hyper /models response").data.map(toProviderModel);
		writeCachedModelPayload(payload);
		return models;
	} catch (err) {
		const cachedPayload = readCachedModelPayload();
		if (cachedPayload !== undefined) {
			console.error(`Failed to fetch Hyper /models, using cached model list: ${String(err)}`);
			return parseSchema(ModelPayloadSchema, cachedPayload, "Hyper model cache").data.map(toProviderModel);
		}
		throw err;
	}
}
