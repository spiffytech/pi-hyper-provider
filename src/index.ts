import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCreditStatus } from "./credits.js";
import { HYPER_API_KEY, PROVIDER_DISPLAY_NAME, PROVIDER_NAME, hyperApiBaseUrl } from "./hyper.js";
import { loadModels } from "./models.js";
import { loginHyper, refreshHyperToken } from "./oauth.js";

export default async function (pi: ExtensionAPI) {
	const models = await loadModels();

	pi.registerProvider(PROVIDER_NAME, {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: hyperApiBaseUrl(),
		apiKey: HYPER_API_KEY,
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
