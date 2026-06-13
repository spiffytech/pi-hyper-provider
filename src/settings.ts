import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const HyperStatusItemsSchema = Type.Object(
	{
		teamName: Type.Optional(Type.Boolean()),
		hypercredits: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type HyperStatusItems = Required<Static<typeof HyperStatusItemsSchema>>;

const DEFAULT_STATUS_ITEMS: HyperStatusItems = {
	teamName: false,
	hypercredits: true,
};

function settingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

export function readHyperStatusItems(): HyperStatusItems {
	const settings = readSettingsObject();
	const hyper = propertyObject(settings, "hyper");
	const statusItems = hyper ? property(hyper, "statusItems") : undefined;
	if (statusItems === undefined) return { ...DEFAULT_STATUS_ITEMS };
	if (!Value.Check(HyperStatusItemsSchema, statusItems)) {
		console.error("Ignoring invalid hyper.statusItems in settings.json");
		return { ...DEFAULT_STATUS_ITEMS };
	}

	return {
		...DEFAULT_STATUS_ITEMS,
		...Value.Parse(HyperStatusItemsSchema, statusItems),
	};
}

export function writeHyperStatusItems(statusItems: HyperStatusItems): void {
	const settings = readSettingsObject();
	const existingHyper = propertyObject(settings, "hyper") ?? {};
	settings.hyper = {
		...existingHyper,
		statusItems,
	};

	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(
		settingsPath(),
		`${JSON.stringify(settings, null, 2)}\n`,
		"utf-8",
	);
}

export function defaultHyperStatusItems(): HyperStatusItems {
	return { ...DEFAULT_STATUS_ITEMS };
}

function readSettingsObject(): Record<string, unknown> {
	const filePath = settingsPath();
	if (!existsSync(filePath)) return {};
	const payload = JSON.parse(readFileSync(filePath, "utf-8"));
	if (!isRecord(payload))
		throw new Error(`${filePath} must contain a JSON object`);
	return payload;
}

function property(source: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function propertyObject(
	source: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = property(source, key);
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
