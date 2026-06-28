import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCreditStatus } from "./credits.js";
import { HYPER_API_KEY, HYPER_USER_AGENT, hyperApiBaseUrl, PROVIDER_DISPLAY_NAME, PROVIDER_NAME } from "./hyper.js";
import { loadModels } from "./models.js";
import { loginHyper, refreshHyperToken } from "./oauth.js";
import { migrateHyperSettings } from "./settings.js";

export default async function (pi: ExtensionAPI) {
	try {
		migrateHyperSettings();
	} catch (err) {
		console.error(`Failed to migrate Hyper settings: ${String(err)}`);
	}
	const models = await loadModels();

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: hyperApiBaseUrl(),
		apiKey: HYPER_API_KEY,
		headers: {
			"User-Agent": HYPER_USER_AGENT,
		},
		api: "openai-completions",
		models,
		oauth: {
			name: PROVIDER_DISPLAY_NAME,
			login: loginHyper,
			refreshToken: refreshHyperToken,
			getApiKey: (credentials) => credentials.access,
		},
	});

	registerCreditStatus(pi);
}
