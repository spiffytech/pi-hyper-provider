import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

export const PROVIDER_NAME = "hyper";
export const PROVIDER_DISPLAY_NAME = "Charm Hyper";
export const DEFAULT_HYPER_URL = "https://hyper.charm.land";
export const HYPER_API_KEY = "$HYPER_API_KEY";
export const HYPER_USER_AGENT = "pi-hyper-provider";

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
