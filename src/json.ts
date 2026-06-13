export type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function property(source: JsonObject, key: string): JsonValue | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	if (!descriptor || !("value" in descriptor)) return undefined;
	return descriptor.value;
}

export function stringProperty(source: JsonObject, key: string): string | undefined {
	const value = property(source, key);
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function numberProperty(source: JsonObject, key: string): number | undefined {
	const value = property(source, key);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanProperty(source: JsonObject, key: string): boolean {
	return property(source, key) === true;
}

export function stringArrayProperty(source: JsonObject, key: string): string[] {
	const value = property(source, key);
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

export function positiveTokenCount(source: JsonObject, key: string, fallback: number): number {
	const value = numberProperty(source, key);
	if (value === undefined || value <= 0) return fallback;
	return Math.floor(value);
}
