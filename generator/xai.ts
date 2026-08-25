/**
 * Shared xAI Grok API helper for generator scripts.
 */

const XAI_URL = "https://api.x.ai/v1/chat/completions";

export interface Xai_options {
	model?: string;
	timeout?: number;
	temperature?: number;
}

const DEFAULT_TIMEOUT = 300000;

export async function xai_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: Xai_options = {}): Promise<string> {
	const model = options.model || Bun.env.XAI_MODEL?.trim();
	if (!model) { throw new Error("XAI_MODEL is not set"); }
	const api_key = Bun.env.XAI_API_KEY?.trim();
	if (!api_key) { throw new Error("XAI_API_KEY is not set"); }
	const { timeout = DEFAULT_TIMEOUT, temperature = 0.1 } = options;

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);
	const start = performance.now();
	console.log(`⚫ xAI Grok: ${title} - model: ${model}`);
	console.log("📤 Request sent");

	try {
		const response = await fetch(XAI_URL, {
			method: "POST",
			signal: controller.signal,
			headers: { Authorization: `Bearer ${api_key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model, temperature, messages: [{ role: "system", content: system_prompt }, { role: "user", content: user_prompt }] }),
		});

		if (!response.ok) {
			const text = await response.text();
			const error: any = new Error(`xAI API error: ${response.status} - ${text}`);
			error.status = response.status;
			throw error;
		}

		const json: any = await response.json();
		const content = json?.choices?.[0]?.message?.content?.trim();
		if (!content) { throw new Error("No content in xAI response"); }

		const elapsed = (performance.now() - start).toFixed(0);
		console.log(`📥 Response received after ${elapsed}ms`);
		return content;
	} finally {
		clearTimeout(timeout_id);
	}
}
