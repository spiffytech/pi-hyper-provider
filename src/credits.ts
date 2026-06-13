import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PROVIDER_NAME, hyperApiBaseUrl, hyperJsonHeaders } from "./hyper.js";
import { fetchJson } from "./http.js";
import { parseSchema } from "./schema.js";
import {
	defaultHyperStatusItems,
	type HyperStatusItems,
	readHyperStatusItems,
	writeHyperStatusItems,
} from "./settings.js";

const HYPER_GEM = "\x1b[38;2;255;96;255m◆\x1b[39m";
const CREDITS_FETCH_TIMEOUT_MS = 10_000;

const CreditsPayloadSchema = Type.Object(
	{
		balance: Type.Number(),
	},
	{ additionalProperties: false },
);

async function fetchCredits(apiKey: string): Promise<number> {
	const payload = await fetchJson(`${hyperApiBaseUrl()}/credits`, {
		headers: hyperJsonHeaders({ Authorization: `Bearer ${apiKey}` }),
		timeoutMs: CREDITS_FETCH_TIMEOUT_MS,
	});
	return parseSchema(CreditsPayloadSchema, payload, "Hyper /credits response").balance;
}

function formatCredits(balance: number): string {
	if (Number.isInteger(balance)) return balance.toLocaleString("en-US");
	return balance.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function isHyperModel(model: ExtensionContext["model"]): model is NonNullable<ExtensionContext["model"]> {
	return model?.provider === PROVIDER_NAME;
}

function statusText(balance: number, statusItems: HyperStatusItems, teamName: string | undefined): string | undefined {
	if (!statusItems.hypercredits) return undefined;
	const credits = `${HYPER_GEM} ${formatCredits(balance)} hc`;
	if (statusItems.teamName && teamName) return `${teamName}: ${credits}`;
	return credits;
}

function storedTeamName(ctx: ExtensionContext): string | undefined {
	const credential = ctx.modelRegistry.authStorage.get(PROVIDER_NAME);
	if (credential?.type !== "oauth") return undefined;
	const teamName = credential.teamName;
	return typeof teamName === "string" && teamName.trim() ? teamName : undefined;
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

		const statusItems = readHyperStatusItems();
		if (!statusItems.hypercredits) {
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
				ctx.ui.setStatus(PROVIDER_NAME, statusText(balance, statusItems, storedTeamName(ctx)));
			}
		} catch (err) {
			console.error(`Failed to fetch Hyper /credits: ${String(err)}`);
			if (generation === refreshGeneration) {
				ctx.ui.setStatus(PROVIDER_NAME, undefined);
			}
		}
	}

	pi.registerCommand("hyper-status", {
		description: "Configure the Charm Hyper footer status",
		handler: async (args, ctx) => {
			const message = updateStatusItems(args);
			ctx.ui.notify(message, "info");
			await refresh(ctx);
		},
	});

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

function updateStatusItems(args: string): string {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return statusItemsSummary(readHyperStatusItems());
	}
	if (tokens.length === 1 && tokens[0] === "reset") {
		const statusItems = defaultHyperStatusItems();
		writeHyperStatusItems(statusItems);
		return `Hyper status reset. ${statusItemsSummary(statusItems)}`;
	}
	if (tokens.length !== 2) {
		return "Usage: /hyper-status [teamName true|false | hypercredits true|false | reset]";
	}

	const key = statusItemKey(tokens[0]);
	const value = booleanArgument(tokens[1]);
	if (!key || value === undefined) {
		return "Usage: /hyper-status [teamName true|false | hypercredits true|false | reset]";
	}

	const statusItems = {
		...readHyperStatusItems(),
		[key]: value,
	};
	writeHyperStatusItems(statusItems);
	return `Hyper status updated. ${statusItemsSummary(statusItems)}`;
}

function statusItemKey(value: string): keyof HyperStatusItems | undefined {
	switch (value.toLowerCase()) {
		case "team":
		case "teamname":
		case "team-name":
			return "teamName";
		case "credits":
		case "hypercredits":
		case "hyper-credits":
			return "hypercredits";
		default:
			return undefined;
	}
}

function booleanArgument(value: string): boolean | undefined {
	switch (value.toLowerCase()) {
		case "true":
		case "on":
		case "yes":
			return true;
		case "false":
		case "off":
		case "no":
			return false;
		default:
			return undefined;
	}
}

function statusItemsSummary(statusItems: HyperStatusItems): string {
	return `teamName=${statusItems.teamName}, hypercredits=${statusItems.hypercredits}`;
}
