import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { fetchJson } from "./http.js";
import { hyperApiBaseUrl, hyperProviderDir, legacyHyperExtensionDir } from "./hyper.js";
import { parseSchema } from "./schema.js";

const MODEL_FETCH_TIMEOUT_MS = 3_000;

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];
// Hyper models without reasoning levels are on/off-only. Use Pi's medium level
// as the single representative "on" state; it is not sent as reasoning_effort.
const ON_OFF_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: "off",
	minimal: null,
	low: null,
	medium: "medium",
	high: null,
	xhigh: null,
};

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
		{ additionalProperties: true },
	),
	Type.Object(
		{
			...HyperModelBaseFields,
			supports_reasoning_effort: Type.Literal(false),
		},
		{ additionalProperties: true },
	),
]);

const ModelPayloadSchema = Type.Object(
	{
		object: Type.Literal("list"),
		data: Type.Array(HyperModelSchema, { minItems: 1 }),
	},
	{ additionalProperties: true },
);

const ProviderModelSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		cost_per_1m_in: Type.Number({ minimum: 0 }),
		cost_per_1m_out: Type.Number({ minimum: 0 }),
		cost_per_1m_in_cached: Type.Number({ minimum: 0 }),
		cost_per_1m_out_cached: Type.Optional(Type.Number({ minimum: 0 })),
		context_window: Type.Integer({ minimum: 1 }),
		default_max_tokens: Type.Integer({ minimum: 1 }),
		can_reason: Type.Boolean(),
		reasoning_levels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		default_reasoning_effort: Type.Optional(Type.String({ minLength: 1 })),
		supports_attachments: Type.Boolean(),
	},
	{ additionalProperties: true },
);

const ProviderPayloadSchema = Type.Object(
	{
		models: Type.Array(ProviderModelSchema, { minItems: 1 }),
	},
	{ additionalProperties: true },
);

type HyperModel = Static<typeof HyperModelSchema>;
type ProviderModel = Static<typeof ProviderModelSchema>;

function modelCachePath(): string {
	return path.join(hyperProviderDir(), "models.json");
}

function legacyModelCachePath(): string {
	return path.join(legacyHyperExtensionDir(), "models.json");
}

function toProviderModel(model: ProviderModel): ProviderModelConfig {
	const input: ProviderModelConfig["input"] = model.supports_attachments ? ["text", "image"] : ["text"];
	const reasoningLevels = model.reasoning_levels ?? [];
	const supportsReasoningEffort = reasoningLevels.length > 0;
	const thinkingLevelMap = supportsReasoningEffort
		? buildThinkingLevelMap(reasoningLevels)
		: model.can_reason
			? ON_OFF_THINKING_LEVEL_MAP
			: undefined;

	return {
		id: model.id,
		name: model.name,
		reasoning: model.can_reason,
		thinkingLevelMap,
		input,
		cost: {
			input: model.cost_per_1m_in,
			output: model.cost_per_1m_out,
			cacheRead: model.cost_per_1m_in_cached,
			// Hyper exposes cached input/output prices, but Pi only models cached
			// input reads and cache writes. Hyper does not expose a cache-write price.
			cacheWrite: 0,
		},
		contextWindow: model.context_window,
		maxTokens: model.default_max_tokens,
		compat: {
			supportsStore: false,
			supportsReasoningEffort,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
	};
}

function toLegacyProviderModel(model: HyperModel): ProviderModelConfig {
	const input: ProviderModelConfig["input"] = model.supports_attachments ? ["text", "image"] : ["text"];
	const thinkingLevelMap = model.supports_reasoning_effort
		? buildThinkingLevelMap(model.reasoning_effort_levels)
		: model.supports_reasoning
			? ON_OFF_THINKING_LEVEL_MAP
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
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
	};
}

function modelsFromPayload(payload: unknown, source: string): ProviderModelConfig[] {
	if (Value.Check(ProviderPayloadSchema, payload)) {
		return Value.Parse(ProviderPayloadSchema, payload).models.map(toProviderModel);
	}
	return parseSchema(ModelPayloadSchema, payload, source).data.map(toLegacyProviderModel);
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
	return fetchJson(`${hyperApiBaseUrl()}/provider`, {
		timeoutMs: MODEL_FETCH_TIMEOUT_MS,
	});
}

function readCachedModelPayload(): unknown | undefined {
	const cachePath = modelCachePath();
	const payload = readJsonCache(cachePath, "Hyper model cache");
	if (payload !== undefined) return payload;

	const legacyPayload = readJsonCache(legacyModelCachePath(), "legacy Hyper model cache");
	if (legacyPayload === undefined) return undefined;

	writeMigratedModelPayload(legacyPayload);
	return legacyPayload;
}

function readJsonCache(cachePath: string, description: string): unknown | undefined {
	if (!existsSync(cachePath)) return undefined;
	try {
		return JSON.parse(readFileSync(cachePath, "utf-8"));
	} catch (err) {
		console.error(`Failed to read ${description} at ${cachePath}: ${String(err)}`);
		return undefined;
	}
}

function writeCachedModelPayload(payload: unknown): void {
	try {
		mkdirSync(hyperProviderDir(), { recursive: true });
		writeFileSync(modelCachePath(), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	} catch (err) {
		console.error(`Failed to write Hyper model cache: ${String(err)}`);
	}
}

function writeMigratedModelPayload(payload: unknown): void {
	const cachePath = modelCachePath();
	try {
		mkdirSync(hyperProviderDir(), { recursive: true });
		writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
		removeLegacyModelCache();
	} catch (err) {
		if (errorCode(err) === "EEXIST") return;
		console.error(`Failed to migrate legacy Hyper model cache to ${cachePath}: ${String(err)}`);
	}
}

function removeLegacyModelCache(): void {
	const cachePath = legacyModelCachePath();
	try {
		unlinkSync(cachePath);
	} catch (err) {
		if (errorCode(err) === "ENOENT") return;
		console.error(`Failed to remove legacy Hyper model cache at ${cachePath}: ${String(err)}`);
	}
}

function migrateModelCache(): void {
	if (existsSync(modelCachePath())) return;
	const legacyPayload = readJsonCache(legacyModelCachePath(), "legacy Hyper model cache");
	if (legacyPayload !== undefined) writeMigratedModelPayload(legacyPayload);
}

function errorCode(err: unknown): string | undefined {
	const code = err instanceof Error ? Object.getOwnPropertyDescriptor(err, "code")?.value : undefined;
	return typeof code === "string" ? code : undefined;
}

export async function loadModels(): Promise<ProviderModelConfig[]> {
	migrateModelCache();
	try {
		const payload = await fetchModelPayload();
		const models = modelsFromPayload(payload, "Hyper /provider response");
		writeCachedModelPayload(payload);
		return models;
	} catch (err) {
		const cachedPayload = readCachedModelPayload();
		if (cachedPayload !== undefined) {
			console.error(`Failed to fetch Hyper /provider, using cached model list: ${String(err)}`);
			return modelsFromPayload(cachedPayload, "Hyper model cache");
		}
		throw err;
	}
}
