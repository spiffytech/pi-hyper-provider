import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { hyperApiBaseUrl, hyperExtensionDir } from "./hyper.js";
import { fetchJson } from "./http.js";
import {
	booleanProperty,
	type JsonObject,
	type JsonValue,
	isJsonObject,
	positiveTokenCount,
	property,
	stringArrayProperty,
	stringProperty,
} from "./json.js";

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

function modelCachePath(): string {
	return path.join(hyperExtensionDir(), "models.json");
}

function parseModelPayload(payload: JsonValue, source: string): HyperModel[] {
	if (!isJsonObject(payload)) {
		throw new Error(`${source} must contain a JSON object`);
	}
	const data = property(payload, "data");
	if (!Array.isArray(data)) {
		throw new Error(`${source} must contain a data array`);
	}

	const models: HyperModel[] = [];
	for (const [index, entry] of data.entries()) {
		if (!isJsonObject(entry)) {
			throw new Error(`${source} data[${index}] must contain a JSON object`);
		}
		models.push(parseHyperModel(entry, `${source} data[${index}]`));
	}
	if (models.length === 0) {
		throw new Error(`${source} contained no models`);
	}
	return models;
}

function parseHyperModel(entry: JsonObject, source: string): HyperModel {
	const id = stringProperty(entry, "id");
	if (!id) throw new Error(`${source} is missing id`);

	return {
		id,
		displayName: stringProperty(entry, "display_name") ?? id,
		supportsReasoning: booleanProperty(entry, "supports_reasoning"),
		supportsReasoningEffort: booleanProperty(entry, "supports_reasoning_effort"),
		reasoningEffortLevels: stringArrayProperty(entry, "reasoning_effort_levels"),
		supportsAttachments: booleanProperty(entry, "supports_attachments"),
		contextWindow: positiveTokenCount(entry, "context_window", DEFAULT_CONTEXT_WINDOW),
		maxOutputTokens: positiveTokenCount(entry, "max_output_tokens", DEFAULT_MAX_TOKENS),
	};
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

async function fetchModelPayload(): Promise<JsonValue> {
	return fetchJson(`${hyperApiBaseUrl()}/models`, {
		timeoutMs: MODEL_FETCH_TIMEOUT_MS,
	});
}

function readCachedModelPayload(): JsonValue | undefined {
	const cachePath = modelCachePath();
	if (!existsSync(cachePath)) return undefined;
	try {
		const payload: JsonValue = JSON.parse(readFileSync(cachePath, "utf-8"));
		return payload;
	} catch (err) {
		console.error(`Failed to read Hyper model cache at ${cachePath}: ${String(err)}`);
		return undefined;
	}
}

function writeCachedModelPayload(payload: JsonValue): void {
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
