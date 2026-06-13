import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "hyper";
const PROVIDER_DISPLAY_NAME = "Charm Hyper";
const DEFAULT_HYPER_URL = "https://hyper.charm.land";
const HYPER_API_KEY = "$HYPER_API_KEY";
const HYPER_GEM = "\x1b[38;2;255;96;255m◆\x1b[39m";
const DEVICE_POLL_INTERVAL_MS = 5000;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const MODEL_FETCH_TIMEOUT_MS = 10_000;
const CREDITS_FETCH_TIMEOUT_MS = 10_000;
const OAUTH_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
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

interface DeviceAuthResponse {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresInSeconds: number;
}

interface TokenExchangeResponse {
	accessToken: string;
	refreshToken: string | undefined;
	expiresInSeconds: number | undefined;
	expiresAtSeconds: number | undefined;
}

interface FetchJsonOptions {
	method?: RequestInit["method"];
	headers?: RequestInit["headers"];
	body?: RequestInit["body"];
	signal?: AbortSignal;
	timeoutMs: number;
}

function hyperBaseUrl(): string {
	const raw = process.env.HYPER_URL?.trim() || DEFAULT_HYPER_URL;
	return raw.replace(/\/+$/, "");
}

function hyperApiBaseUrl(): string {
	return `${hyperBaseUrl()}/v1`;
}

function hyperExtensionDir(): string {
	return path.join(getAgentDir(), "extensions", "hyper-provider");
}

function modelCachePath(): string {
	return path.join(hyperExtensionDir(), "models.json");
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(source: JsonObject, key: string): JsonValue | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	if (!descriptor || !("value" in descriptor)) return undefined;
	return descriptor.value;
}

function stringProperty(source: JsonObject, key: string): string | undefined {
	const value = property(source, key);
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberProperty(source: JsonObject, key: string): number | undefined {
	const value = property(source, key);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanProperty(source: JsonObject, key: string): boolean {
	return property(source, key) === true;
}

function stringArrayProperty(source: JsonObject, key: string): string[] {
	const value = property(source, key);
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function positiveTokenCount(source: JsonObject, key: string, fallback: number): number {
	const value = numberProperty(source, key);
	if (value === undefined || value <= 0) return fallback;
	return Math.floor(value);
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
	const result: ThinkingLevelMap = { off: availableLevels.has("off") ? "off" : null };
	for (const level of ["minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[]) {
		result[level] = availableLevels.has(level) ? level : null;
	}
	return result;
}

async function fetchJson(url: string, options: FetchJsonOptions): Promise<JsonValue> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	const abortFromCaller = () => controller.abort();
	if (options.signal?.aborted) {
		controller.abort();
	} else {
		options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	}

	try {
		const response = await fetch(url, {
			method: options.method,
			headers: options.headers,
			body: options.body,
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`${url} returned ${response.status}: ${body}`);
		}
		const payload: JsonValue = await response.json();
		return payload;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

async function fetchModelPayload(): Promise<JsonValue> {
	return fetchJson(`${hyperApiBaseUrl()}/models`, { timeoutMs: MODEL_FETCH_TIMEOUT_MS });
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

async function loadModels(): Promise<ProviderModelConfig[]> {
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

function parseDeviceAuthResponse(payload: JsonValue): DeviceAuthResponse {
	if (!isJsonObject(payload)) throw new Error("Hyper device auth response must contain a JSON object");
	const deviceCode = stringProperty(payload, "device_code");
	const userCode = stringProperty(payload, "user_code");
	const verificationUri = stringProperty(payload, "verification_url") ?? stringProperty(payload, "verification_uri");
	const expiresInSeconds = numberProperty(payload, "expires_in");

	if (!deviceCode) throw new Error("Hyper device auth response is missing device_code");
	if (!userCode) throw new Error("Hyper device auth response is missing user_code");
	if (!verificationUri) throw new Error("Hyper device auth response is missing verification URL");
	if (expiresInSeconds === undefined || expiresInSeconds <= 0) {
		throw new Error("Hyper device auth response is missing a valid expires_in");
	}

	return {
		deviceCode,
		userCode,
		verificationUri,
		expiresInSeconds: Math.floor(expiresInSeconds),
	};
}

function parseTokenExchangeResponse(payload: JsonValue): TokenExchangeResponse {
	if (!isJsonObject(payload)) throw new Error("Hyper token exchange response must contain a JSON object");
	const accessToken = stringProperty(payload, "access_token");
	if (!accessToken) throw new Error("Hyper token exchange response is missing access_token");

	return {
		accessToken,
		refreshToken: stringProperty(payload, "refresh_token"),
		expiresInSeconds: numberProperty(payload, "expires_in"),
		expiresAtSeconds: numberProperty(payload, "expires_at"),
	};
}

async function initiateDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthResponse> {
	const payload = await fetchJson(`${hyperBaseUrl()}/device/auth`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "pi-hyper-provider",
		},
		body: JSON.stringify({ device_name: deviceName() }),
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	return parseDeviceAuthResponse(payload);
}

function deviceName(): string {
	const host = hostname();
	return host ? `Pi (${host})` : "Pi";
}

async function pollDeviceAuth(deviceCode: string, expiresInSeconds: number, signal?: AbortSignal): Promise<string> {
	const deadline = Date.now() + expiresInSeconds * 1000;
	while (Date.now() < deadline) {
		await sleep(DEVICE_POLL_INTERVAL_MS, undefined, { signal });
		const payload = await fetchJson(`${hyperBaseUrl()}/device/auth/${encodeURIComponent(deviceCode)}`, {
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "pi-hyper-provider",
			},
			signal,
			timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
		});
		if (!isJsonObject(payload)) throw new Error("Hyper device token response must contain a JSON object");

		const refreshToken = stringProperty(payload, "refresh_token");
		if (refreshToken) return refreshToken;

		const error = stringProperty(payload, "error");
		if (error === "authorization_pending") continue;

		const errorDescription = stringProperty(payload, "error_description") ?? error ?? "unknown error";
		throw new Error(`Hyper device authorization failed: ${errorDescription}`);
	}
	throw new Error("Hyper device authorization expired");
}

async function exchangeRefreshToken(refreshToken: string, signal?: AbortSignal): Promise<TokenExchangeResponse> {
	const payload = await fetchJson(`${hyperBaseUrl()}/token/exchange`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "pi-hyper-provider",
		},
		body: JSON.stringify({ refresh_token: refreshToken }),
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	return parseTokenExchangeResponse(payload);
}

function tokenToCredentials(token: TokenExchangeResponse, fallbackRefreshToken: string): OAuthCredentials {
	const refreshToken = token.refreshToken ?? fallbackRefreshToken;
	const expires = tokenExpiresAtMs(token);
	return {
		refresh: refreshToken,
		access: token.accessToken,
		expires,
	};
}

function tokenExpiresAtMs(token: TokenExchangeResponse): number {
	if (token.expiresInSeconds !== undefined && token.expiresInSeconds > 0) {
		return Date.now() + token.expiresInSeconds * 1000 - TOKEN_EXPIRY_BUFFER_MS;
	}
	if (token.expiresAtSeconds !== undefined && token.expiresAtSeconds > 0) {
		return token.expiresAtSeconds * 1000 - TOKEN_EXPIRY_BUFFER_MS;
	}
	throw new Error("Hyper token exchange response is missing token expiry information");
}

async function loginHyper(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const deviceAuth = await initiateDeviceAuth(callbacks.signal);
	callbacks.onDeviceCode({
		userCode: deviceAuth.userCode,
		verificationUri: deviceAuth.verificationUri,
		intervalSeconds: DEVICE_POLL_INTERVAL_MS / 1000,
		expiresInSeconds: deviceAuth.expiresInSeconds,
	});

	const refreshToken = await pollDeviceAuth(deviceAuth.deviceCode, deviceAuth.expiresInSeconds, callbacks.signal);
	const token = await exchangeRefreshToken(refreshToken, callbacks.signal);
	return tokenToCredentials(token, refreshToken);
}

async function refreshHyperToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const token = await exchangeRefreshToken(credentials.refresh);
	return tokenToCredentials(token, credentials.refresh);
}

async function fetchCredits(apiKey: string): Promise<number> {
	const payload = await fetchJson(`${hyperApiBaseUrl()}/credits`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		timeoutMs: CREDITS_FETCH_TIMEOUT_MS,
	});
	if (!isJsonObject(payload)) throw new Error("Hyper credits response must contain a JSON object");
	const balance = numberProperty(payload, "balance");
	if (balance === undefined) throw new Error("Hyper credits response is missing balance");
	return balance;
}

function formatCredits(balance: number): string {
	if (Number.isInteger(balance)) return balance.toLocaleString("en-US");
	return balance.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function isHyperModel(model: ExtensionContext["model"]): model is NonNullable<ExtensionContext["model"]> {
	return model?.provider === PROVIDER_NAME;
}

function statusText(balance: number): string {
	return `${HYPER_GEM} ${formatCredits(balance)} hc`;
}

function registerCreditStatus(pi: ExtensionAPI): void {
	let refreshGeneration = 0;

	async function refresh(ctx: ExtensionContext, selectedModel: ExtensionContext["model"] = ctx.model): Promise<void> {
		const generation = refreshGeneration + 1;
		refreshGeneration = generation;

		if (!isHyperModel(selectedModel)) {
			ctx.ui.setStatus(PROVIDER_NAME, undefined);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.setStatus(PROVIDER_NAME, undefined);
			return;
		}

		try {
			const balance = await fetchCredits(auth.apiKey);
			if (generation === refreshGeneration) {
				ctx.ui.setStatus(PROVIDER_NAME, statusText(balance));
			}
		} catch (err) {
			console.error(`Failed to fetch Hyper credits: ${String(err)}`);
			if (generation === refreshGeneration) {
				ctx.ui.setStatus(PROVIDER_NAME, undefined);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		await refresh(ctx, event.model);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant" && isHyperModel(ctx.model)) {
			await refresh(ctx);
		}
	});
}

export default async function (pi: ExtensionAPI) {
	const models = await loadModels();

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: hyperApiBaseUrl(),
		apiKey: HYPER_API_KEY,
		api: "openai-completions",
		models,
		oauth: {
			name: PROVIDER_DISPLAY_NAME,
			login: loginHyper,
			refreshToken: refreshHyperToken,
			getApiKey: (credentials) => credentials.access,
		},
	});

	registerCreditStatus(pi);
}
