import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { HYPER_USER_AGENT, hyperBaseUrl } from "./hyper.js";
import { fetchJson } from "./http.js";
import { isJsonObject, type JsonValue, numberProperty, stringProperty } from "./json.js";

const DEVICE_POLL_INTERVAL_MS = 5000;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

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
			"User-Agent": HYPER_USER_AGENT,
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
				"User-Agent": HYPER_USER_AGENT,
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
			"User-Agent": HYPER_USER_AGENT,
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

export async function loginHyper(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
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

export async function refreshHyperToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const token = await exchangeRefreshToken(credentials.refresh);
	return tokenToCredentials(token, credentials.refresh);
}
