import { hostname } from "node:os";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { pollOAuthDeviceCodeFlow } from "@earendil-works/pi-ai/oauth";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { hyperBaseUrl, hyperJsonHeaders } from "./hyper.js";
import { fetchJson } from "./http.js";
import { parseSchema } from "./schema.js";

const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

const DeviceAuthResponseSchema = Type.Object(
	{
		device_code: Type.String({ minLength: 1 }),
		expires_in: Type.Integer({ minimum: 1 }),
		user_code: Type.String({ minLength: 1 }),
		verification_url: Type.String({ minLength: 1 }),
		interval: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const DevicePollSuccessSchema = Type.Object(
	{
		refresh_token: Type.String({ minLength: 1 }),
		team_id: Type.String({ minLength: 1 }),
		team_name: Type.String({ minLength: 1 }),
		user_id: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const DevicePollErrorCodeSchema = Type.Union([
	Type.Literal("authorization_pending"),
	Type.Literal("slow_down"),
	Type.Literal("access_denied"),
	Type.Literal("expired_token"),
	Type.Literal("invalid_request"),
	Type.Literal("invalid_grant"),
]);

const DevicePollErrorSchema = Type.Object(
	{
		error: DevicePollErrorCodeSchema,
		error_description: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const DevicePollResponseSchema = Type.Union([DevicePollSuccessSchema, DevicePollErrorSchema]);

const TokenExchangeWithExpiresInSchema = Type.Object(
	{
		access_token: Type.String({ minLength: 1 }),
		token_type: Type.String({ minLength: 1 }),
		refresh_token: Type.String({ minLength: 1 }),
		expiry: Type.String({ minLength: 1 }),
		expires_in: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const TokenExchangeWithExpiresAtSchema = Type.Object(
	{
		access_token: Type.String({ minLength: 1 }),
		token_type: Type.String({ minLength: 1 }),
		refresh_token: Type.String({ minLength: 1 }),
		expiry: Type.String({ minLength: 1 }),
		expires_at: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const TokenExchangeResponseSchema = Type.Union([TokenExchangeWithExpiresInSchema, TokenExchangeWithExpiresAtSchema]);

type DeviceAuthResponse = Static<typeof DeviceAuthResponseSchema>;
type DevicePollResponse = Static<typeof DevicePollSuccessSchema> | Static<typeof DevicePollErrorSchema>;
type DevicePollSuccess = Static<typeof DevicePollSuccessSchema>;
type TokenExchangeResponse =
	| Static<typeof TokenExchangeWithExpiresInSchema>
	| Static<typeof TokenExchangeWithExpiresAtSchema>;

type HyperOAuthCredentials = OAuthCredentials & {
	teamName?: string;
};

async function initiateDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthResponse> {
	const payload = await fetchJson(`${hyperBaseUrl()}/device/auth`, {
		method: "POST",
		headers: hyperJsonHeaders(),
		body: JSON.stringify({ device_name: deviceName() }),
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	return parseSchema(DeviceAuthResponseSchema, payload, "Hyper device auth response");
}

function deviceName(): string {
	const host = hostname();
	return host ? `Pi (${host})` : "Pi";
}

async function pollDeviceAuth(deviceAuth: DeviceAuthResponse, signal?: AbortSignal): Promise<DevicePollSuccess> {
	return pollOAuthDeviceCodeFlow<DevicePollSuccess>({
		intervalSeconds: deviceAuth.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
		expiresInSeconds: deviceAuth.expires_in,
		signal,
		poll: async () => {
			const payload = await fetchJson(`${hyperBaseUrl()}/device/auth/${encodeURIComponent(deviceAuth.device_code)}`, {
				headers: hyperJsonHeaders(),
				signal,
				timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
				allowHttpErrorPayload: true,
			});
			const response = parseDevicePollResponse(payload);

			if ("refresh_token" in response) {
				return { status: "complete", value: response };
			}
			if (response.error === "authorization_pending") return { status: "pending" };
			if (response.error === "slow_down") return { status: "slow_down" };

			return {
				status: "failed",
				message: `Hyper device authorization failed: ${response.error_description ?? response.error}`,
			};
		},
	});
}

function parseDevicePollResponse(payload: unknown): DevicePollResponse {
	if (Value.Check(DevicePollSuccessSchema, payload)) {
		return Value.Parse(DevicePollSuccessSchema, payload);
	}
	if (Value.Check(DevicePollErrorSchema, payload)) {
		return Value.Parse(DevicePollErrorSchema, payload);
	}
	parseSchema(DevicePollResponseSchema, payload, "Hyper device token response");
	throw new Error("Hyper device token response is invalid");
}

async function exchangeRefreshToken(refreshToken: string, signal?: AbortSignal): Promise<TokenExchangeResponse> {
	const payload = await fetchJson(`${hyperBaseUrl()}/token/exchange`, {
		method: "POST",
		headers: hyperJsonHeaders(),
		body: JSON.stringify({ refresh_token: refreshToken }),
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	return parseTokenExchangeResponse(payload);
}

function parseTokenExchangeResponse(payload: unknown): TokenExchangeResponse {
	if (Value.Check(TokenExchangeWithExpiresInSchema, payload)) {
		return Value.Parse(TokenExchangeWithExpiresInSchema, payload);
	}
	if (Value.Check(TokenExchangeWithExpiresAtSchema, payload)) {
		return Value.Parse(TokenExchangeWithExpiresAtSchema, payload);
	}
	parseSchema(TokenExchangeResponseSchema, payload, "Hyper token exchange response");
	throw new Error("Hyper token exchange response is invalid");
}

function tokenToCredentials(
	token: TokenExchangeResponse,
	fallbackRefreshToken: string,
	metadata?: Pick<HyperOAuthCredentials, "teamName">,
): OAuthCredentials {
	const expires = tokenExpiresAtMs(token);
	return {
		refresh: token.refresh_token || fallbackRefreshToken,
		access: token.access_token,
		expires,
		...metadata,
	};
}

function tokenExpiresAtMs(token: TokenExchangeResponse): number {
	const now = Date.now();
	const expiresAt = "expires_in" in token ? now + token.expires_in * 1000 : token.expires_at * 1000;
	if (expiresAt <= now) {
		throw new Error("Hyper token exchange response contains an expired token expiry");
	}

	const bufferMs = Math.min(TOKEN_EXPIRY_BUFFER_MS, Math.floor((expiresAt - now) / 2));
	return expiresAt - bufferMs;
}

export async function loginHyper(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const deviceAuth = await initiateDeviceAuth(callbacks.signal);
	callbacks.onDeviceCode({
		userCode: deviceAuth.user_code,
		verificationUri: deviceAuth.verification_url,
		intervalSeconds: deviceAuth.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
		expiresInSeconds: deviceAuth.expires_in,
	});

	const deviceToken = await pollDeviceAuth(deviceAuth, callbacks.signal);
	const token = await exchangeRefreshToken(deviceToken.refresh_token, callbacks.signal);
	return tokenToCredentials(token, deviceToken.refresh_token, {
		teamName: deviceToken.team_name,
	});
}

export async function refreshHyperToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const token = await exchangeRefreshToken(credentials.refresh);
	return tokenToCredentials(token, credentials.refresh, {
		teamName: teamNameFromCredentials(credentials),
	});
}

function teamNameFromCredentials(credentials: OAuthCredentials): string | undefined {
	const teamName = (credentials as HyperOAuthCredentials).teamName;
	return typeof teamName === "string" && teamName.trim() ? teamName : undefined;
}
