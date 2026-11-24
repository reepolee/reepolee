/**
 * Shared Anthropic Claude API helper for generator scripts.
 */

import { retry_after_ms } from "./retry_after";

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

export interface ClaudeOptions {
	model?: string;
	timeout?: number;
	temperature?: number;
}

const DEFAULT_TIMEOUT = 300000;

export async function claude_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: ClaudeOptions = {}): Promise<string> {
	const model = options.model || Bun.env.CLAUDE_MODEL?.trim();
	if (!model) { throw new Error("CLAUDE_MODEL is not set"); }
	const { timeout = DEFAULT_TIMEOUT, temperature = 0.1 } = options;
	const api_key = Bun.env.CLAUDE_API_KEY?.trim();
	if (!api_key) { throw new Error("CLAUDE_API_KEY is not set"); }

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);
	const start = performance.now();
	console.log(`🟠 Claude: ${title} - model: ${model}`);
	console.log("📤 Request sent");

	try {
		const response = await fetch(CLAUDE_URL, {
			method: "POST",
			signal: controller.signal,
			headers: { "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
			body: JSON.stringify({ model, max_tokens: 8192, temperature, system: system_prompt, messages: [{ role: "user", content: user_prompt }] }),
		});

		if (!response.ok) {
			const text = await response.text();
			const error: any = new Error(`Claude API error: ${response.status} - ${text}`);
			error.status = response.status;
			error.retry_after_ms = retry_after_ms(response.headers, text);
			throw error;
		}

		const json: any = await response.json();
		const content = json?.content?.find((block: any) => block?.type === "text")?.text?.trim();
		if (!content) { throw new Error("No content in Claude response"); }

		const elapsed = (performance.now() - start).toFixed(0);
		console.log(`📥 Response received after ${elapsed}ms`);
		return content;
	} finally {
		clearTimeout(timeout_id);
	}
}
