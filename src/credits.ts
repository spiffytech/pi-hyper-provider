import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { PROVIDER_NAME, hyperApiBaseUrl } from "./hyper.js";
import { fetchJson } from "./http.js";

const HYPER_GEM = "\x1b[38;2;255;96;255m◆\x1b[39m";
const CREDITS_FETCH_TIMEOUT_MS = 10_000;

const CreditsPayloadSchema = Type.Object(
	{
		balance: Type.Number(),
	},
	{ additionalProperties: true },
);

type CreditsPayload = Static<typeof CreditsPayloadSchema>;

function parseCreditsPayload(payload: unknown): CreditsPayload {
	if (!Value.Check(CreditsPayloadSchema, payload)) {
		throw new Error(`Hyper credits response is invalid: ${formatCreditsValidationErrors(payload)}`);
	}
	return Value.Parse(CreditsPayloadSchema, payload);
}

function formatCreditsValidationErrors(payload: unknown): string {
	return Value.Errors(CreditsPayloadSchema, payload)
		.slice(0, 3)
		.map((error) => `Hyper credits response${error.instancePath} ${error.message}`)
		.join("; ");
}

async function fetchCredits(apiKey: string): Promise<number> {
	const payload = await fetchJson(`${hyperApiBaseUrl()}/credits`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		timeoutMs: CREDITS_FETCH_TIMEOUT_MS,
	});
	const { balance } = parseCreditsPayload(payload);
	if (!Number.isFinite(balance)) {
		throw new Error("Hyper credits response balance must be a finite number");
	}
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

export function registerCreditStatus(pi: ExtensionAPI): void {
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
