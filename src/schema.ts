import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export function parseSchema<const Schema extends TSchema>(
	schema: Schema,
	payload: unknown,
	source: string,
): Static<Schema> {
	if (Value.Check(schema, payload)) {
		return Value.Parse(schema, payload);
	}

	const details = [...Value.Errors(schema, payload)]
		.slice(0, 3)
		.map((error) => `${formatErrorPath(source, error.instancePath)} ${error.message}`)
		.join("; ");
	throw new Error(`${source} is invalid: ${details || "unknown validation error"}`);
}

function formatErrorPath(source: string, instancePath: string): string {
	if (!instancePath) return source;
	return `${source}${instancePath}`;
}
