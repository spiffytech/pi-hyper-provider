export interface FetchJsonOptions {
	method?: RequestInit["method"];
	headers?: RequestInit["headers"];
	body?: RequestInit["body"];
	signal?: AbortSignal;
	timeoutMs: number;
	allowHttpErrorPayload?: boolean;
}

export interface FetchJsonResponse {
	status: number;
	ok: boolean;
	payload: unknown;
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
	return (await fetchJsonResponse(url, options)).payload;
}

export async function fetchJsonResponse(url: string, options: FetchJsonOptions): Promise<FetchJsonResponse> {
	const controller = new AbortController();
	let timedOut = false;
	let callerAborted = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);
	const abortFromCaller = () => {
		callerAborted = true;
		controller.abort();
	};
	if (options.signal?.aborted) {
		callerAborted = true;
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
		const body = await response.text();
		if (!response.ok && !options.allowHttpErrorPayload) {
			throw new Error(`${url} returned HTTP ${response.status}: ${summarizeBody(body)}`);
		}
		return {
			status: response.status,
			ok: response.ok,
			payload: parseJsonBody(url, response.status, body),
		};
	} catch (err) {
		if (timedOut) {
			throw new Error(`${url} timed out after ${options.timeoutMs}ms`, { cause: err });
		}
		if (callerAborted) {
			throw new Error(`${url} request was aborted`, { cause: err });
		}
		throw err;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

function parseJsonBody(url: string, status: number, body: string): unknown {
	if (!body.trim()) {
		throw new Error(`${url} returned HTTP ${status} with an empty JSON body`);
	}
	try {
		return JSON.parse(body);
	} catch (err) {
		throw new Error(`${url} returned invalid JSON (HTTP ${status}): ${summarizeBody(body)}`, { cause: err });
	}
}

function summarizeBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "empty response body";
	const maxBodyCharacters = 2_000;
	if (trimmed.length <= maxBodyCharacters) return trimmed;
	return `${trimmed.slice(0, maxBodyCharacters)}…`;
}
