export interface FetchJsonOptions {
	method?: RequestInit["method"];
	headers?: RequestInit["headers"];
	body?: RequestInit["body"];
	signal?: AbortSignal;
	timeoutMs: number;
	allowHttpErrorPayload?: boolean;
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	const abortFromCaller = () => controller.abort();
	if (options.signal?.aborted) {
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
		if (!response.ok && !options.allowHttpErrorPayload) {
			const body = await response.text();
			throw new Error(`${url} returned ${response.status}: ${body}`);
		}
		return response.json();
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}
