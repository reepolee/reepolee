/**
 * Shared Google Gemini API helper for generator scripts.
 *
 * Uses the v1beta generateContent endpoint. The system prompt is passed via
 * systemInstruction and the user prompt as the single content part. Thinking is
 * disabled (thinkingBudget: 0) so short translation calls stay fast.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiOptions {
	model?: string;
	timeout?: number;
	temperature?: number;
}

const DEFAULT_MODEL = Bun.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const DEFAULT_TIMEOUT = 300000;

/**
 * Query the Gemini API with timeout and a system + user prompt.
 * Returns the trimmed text from the first candidate.
 */
export async function gemini_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: GeminiOptions = {}): Promise<string> {
	const { model = DEFAULT_MODEL, timeout = DEFAULT_TIMEOUT, temperature = 0.1 } = options;

	const api_key = Bun.env.GEMINI_API_KEY?.trim();
	if (!api_key) { throw new Error("GEMINI_API_KEY is not set"); }

	const url = `${GEMINI_BASE}/${model}:generateContent?key=${api_key}`;

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);

	const start = performance.now();
	console.log(`✨ Gemini: ${title} - model: ${model}`);
	console.log(`📤 JSON sent:\n${user_prompt}`);

	try {
		const res = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: system_prompt }] },
				contents: [{ parts: [{ text: user_prompt }] }],
				generationConfig: { temperature, thinkingConfig: { thinkingBudget: 0 } },
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			const elapsed = (performance.now() - start).toFixed(0);
			const err: any = new Error(`Gemini API error: ${res.status} - ${text}`);
			err.status = res.status;
			console.error(`❌ Gemini error after ${elapsed}ms: ${res.status}`);
			throw err;
		}

		const json: any = await res.json();
		const content = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

		if (!content) {
			const elapsed = (performance.now() - start).toFixed(0);
			console.error(`❌ Gemini empty response after ${elapsed}ms`);
			throw new Error("No content in Gemini response");
		}

		const elapsed = (performance.now() - start).toFixed(0);
		console.log(`📥 JSON received after ${elapsed}ms:\n${content.slice(0, 2000)}`);

		return content;
	} finally {
		clearTimeout(timeout_id);
	}
}
