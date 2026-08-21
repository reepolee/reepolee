/**
 * Shared OpenAI API helper for generator scripts.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export interface OpenaiOptions {
	model?: string;
	timeout?: number;
	temperature?: number;
}

const DEFAULT_TIMEOUT = 300000;

export async function openai_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: OpenaiOptions = {}): Promise<string> {
	const model = options.model || Bun.env.OPENAI_MODEL?.trim();
	if (!model) { throw new Error("OPENAI_MODEL is not set"); }
	const { timeout = DEFAULT_TIMEOUT, temperature = 0.1 } = options;
	const api_key = Bun.env.OPENAI_API_KEY?.trim();
	if (!api_key) { throw new Error("OPENAI_API_KEY is not set"); }

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);
	const start = performance.now();
	console.log(`🟢 OpenAI: ${title} - model: ${model}`);
	console.log("📤 Request sent");

	try {
		const response = await fetch(OPENAI_URL, {
			method: "POST",
			signal: controller.signal,
			headers: { Authorization: `Bearer ${api_key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model, temperature, messages: [{ role: "system", content: system_prompt }, { role: "user", content: user_prompt }] }),
		});

		if (!response.ok) {
			const text = await response.text();
			const error: any = new Error(`OpenAI API error: ${response.status} - ${text}`);
			error.status = response.status;
			throw error;
		}

		const json: any = await response.json();
		const content = json?.choices?.[0]?.message?.content?.trim();
		if (!content) { throw new Error("No content in OpenAI response"); }

		const elapsed = (performance.now() - start).toFixed(0);
		console.log(`📥 Response received after ${elapsed}ms`);
		return content;
	} finally {
		clearTimeout(timeout_id);
	}
}
