/**
 * Shared OpenRouter API helper for generator scripts.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterOptions {
	model?: string;
	timeout?: number;
	temperature?: number;
}

const DEFAULT_MODEL = Bun.env.OPENROUTER_MODEL || "tencent/hy3-preview:free";
const DEFAULT_TIMEOUT = 300000;

/**
 * Query OpenRouter API with timeout and common headers.
 * Returns the trimmed content string from the first choice.
 */
export async function openrouter_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: OpenRouterOptions = {}): Promise<string> {
	const { model = DEFAULT_MODEL, timeout = DEFAULT_TIMEOUT, temperature = 0.1 } = options;

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);

	const start = performance.now();
	console.log(`🤖 OpenRouter: ${title} - model: ${model}`);
	console.log(`📤 JSON sent:\n${user_prompt}`);

	try {
		const res = await fetch(OPENROUTER_URL, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${Bun.env.OPENROUTER_KEY?.trim()}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "http://localhost",
				"X-Title": title,
			},
			body: JSON.stringify({
				model,
				temperature,
				thinking: { enabled: false },
				messages: [{ role: "system", content: system_prompt }, { role: "user", content: user_prompt }],
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			const elapsed = (performance.now() - start).toFixed(0);
			const err: any = new Error(`OpenRouter API error: ${res.status} - ${text}`);
			err.status = res.status;
			console.error(`❌ OpenRouter error after ${elapsed}ms: ${res.status}`);
			throw err;
		}

		const json: any = await res.json();
		const content = json?.choices?.[0]?.message?.content?.trim();

		if (!content) {
			const elapsed = (performance.now() - start).toFixed(0);
			console.error(`❌ OpenRouter empty response after ${elapsed}ms`);
			throw new Error("No content in OpenRouter response");
		}

		const elapsed = (performance.now() - start).toFixed(0);
		console.log(`📥 JSON received after ${elapsed}ms:\n${content.slice(0, 2000)}`);

		return content;
	} finally {
		clearTimeout(timeout_id);
	}
}
