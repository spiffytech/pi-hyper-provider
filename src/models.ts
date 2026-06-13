import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { hyperApiBaseUrl, hyperExtensionDir } from "./hyper.js";
import { fetchJson } from "./http.js";

const MODEL_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<"off" | ThinkingLevel, string | null>>;

interface HyperModel {
	id: string;
	displayName: string;
	supportsReasoning: boolean;
	supportsReasoningEffort: boolean;
	reasoningEffortLevels: string[];
	supportsAttachments: boolean;
	contextWindow: number;
	maxOutputTokens: number;
}

const RawHyperModelSchema = Type.Object(
	{
		id: Type.String(),
		display_name: Type.Optional(Type.Unknown()),
		supports_reasoning: Type.Optional(Type.Unknown()),
		supports_reasoning_effort: Type.Optional(Type.Unknown()),
		reasoning_effort_levels: Type.Optional(Type.Unknown()),
		supports_attachments: Type.Optional(Type.Unknown()),
		context_window: Type.Optional(Type.Unknown()),
		max_output_tokens: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: true },
);

const ModelPayloadSchema = Type.Object(
	{
		data: Type.Array(RawHyperModelSchema),
	},
	{ additionalProperties: true },
);

type RawHyperModel = Static<typeof RawHyperModelSchema>;

function modelCachePath(): string {
	return path.join(hyperExtensionDir(), "models.json");
}

function parseWithSchema<const Schema extends TSchema>(
	schema: Schema,
	payload: unknown,
	source: string,
): Static<Schema> {
	if (!Value.Check(schema, payload)) {
		throw new Error(`${source} is invalid: ${formatValidationErrors(source, schema, payload)}`);
	}
	return Value.Parse(schema, payload);
}

function formatValidationErrors(source: string, schema: TSchema, payload: unknown): string {
	return Value.Errors(schema, payload)
		.slice(0, 3)
		.map((error) => `${formatErrorPath(source, error.instancePath)} ${error.message}`)
		.join("; ");
}

function formatErrorPath(source: string, instancePath: string): string {
	if (!instancePath) return source;
	return `${source}${instancePath}`;
}

function parseModelPayload(payload: unknown, source: string): HyperModel[] {
	const parsed = parseWithSchema(ModelPayloadSchema, payload, source);
	if (parsed.data.length === 0) {
		throw new Error(`${source} contained no models`);
	}
	return parsed.data.map((entry, index) => parseHyperModel(entry, `${source} data[${index}]`));
}

function parseHyperModel(entry: RawHyperModel, source: string): HyperModel {
	const id = nonEmptyString(entry.id);
	if (!id) throw new Error(`${source} is missing id`);

	return {
		id,
		displayName: nonEmptyString(entry.display_name) ?? id,
		supportsReasoning: entry.supports_reasoning === true,
		supportsReasoningEffort: entry.supports_reasoning_effort === true,
		reasoningEffortLevels: stringArray(entry.reasoning_effort_levels),
		supportsAttachments: entry.supports_attachments === true,
		contextWindow: positiveTokenCount(entry.context_window, DEFAULT_CONTEXT_WINDOW),
		maxOutputTokens: positiveTokenCount(entry.max_output_tokens, DEFAULT_MAX_TOKENS),
	};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function positiveTokenCount(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

function toProviderModel(model: HyperModel): ProviderModelConfig {
	const input: ProviderModelConfig["input"] = model.supportsAttachments ? ["text", "image"] : ["text"];
	const thinkingLevelMap = model.supportsReasoningEffort
		? buildThinkingLevelMap(model.reasoningEffortLevels)
		: undefined;

	return {
		id: model.id,
		name: model.displayName,
		reasoning: model.supportsReasoning,
		thinkingLevelMap,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxOutputTokens,
		compat: {
			supportsStore: false,
			supportsReasoningEffort: model.supportsReasoningEffort,
			maxTokensField: "max_tokens",
		},
	};
}

function buildThinkingLevelMap(levels: string[]): ThinkingLevelMap | undefined {
	if (levels.length === 0) return undefined;
	const availableLevels = new Set(levels);
	const result: ThinkingLevelMap = {
		off: availableLevels.has("off") ? "off" : null,
	};
	for (const level of ["minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[]) {
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
		const models = parseModelPayload(payload, "Hyper model response").map(toProviderModel);
		writeCachedModelPayload(payload);
		return models;
	} catch (err) {
		const cachedPayload = readCachedModelPayload();
		if (cachedPayload !== undefined) {
			console.error(`Failed to fetch Hyper models, using cached model list: ${String(err)}`);
			return parseModelPayload(cachedPayload, "Hyper model cache").map(toProviderModel);
		}
		throw err;
	}
}
