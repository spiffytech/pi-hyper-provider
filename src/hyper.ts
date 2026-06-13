import { createRequire } from "node:module";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
	name: string;
	version: string;
};
const packageName = packageJson.name.split("/").at(-1) ?? "pi-hyper-provider";

export const PROVIDER_NAME = "hyper";
export const PROVIDER_DISPLAY_NAME = "Charm Hyper";
export const DEFAULT_HYPER_URL = "https://hyper.charm.land";
export const HYPER_API_KEY = "$HYPER_API_KEY";
export const HYPER_USER_AGENT = `${packageName}/${packageJson.version}`;

export function hyperBaseUrl(): string {
	const raw = process.env.HYPER_URL?.trim() || DEFAULT_HYPER_URL;
	return raw.replace(/\/+$/, "");
}

export function hyperApiBaseUrl(): string {
	return `${hyperBaseUrl()}/v1`;
}

export function hyperExtensionDir(): string {
	return path.join(getAgentDir(), "extensions", "hyper-provider");
}

export function hyperJsonHeaders(headers: Record<string, string> = {}): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": HYPER_USER_AGENT,
		...headers,
	};
}
