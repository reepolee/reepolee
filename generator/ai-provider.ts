/**
 * AI provider abstraction for generator scripts.
 *
 * Supports:
 * - Ollama (local LLM via OpenAI-compatible endpoint) - highest priority
 * - Gemini (Google Generative Language API)
 * - HuggingFace (via Helsinki-NLP translation models on HF Inference API)
 * - OpenRouter (cloud LLM)
 *
 * Provider selection priority:
 * Exactly one provider must be configured.
 */

import { env_available } from "$config/env_vars";
import { openrouter_query } from "./openrouter";
import { gemini_query } from "./gemini";
import { openai_query } from "./openai";
import { claude_query } from "./claude";
import { xai_query } from "./xai";
import { retry_after_ms, retry_delay_ms } from "./retry_after";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export type ActiveProvider = "openrouter" | "huggingface" | "ollama" | "gemini" | "openai" | "claude" | "xai";

type Chat_options = { model?: string; timeout?: number; temperature?: number; };

const provider_checks = new Map<ActiveProvider, () => boolean>([
	["ollama", () => env_available("OLLAMA_URL")],
	["gemini", () => env_available("GEMINI_API_KEY")],
	["openai", () => env_available("OPENAI_API_KEY")],
	["claude", () => env_available("CLAUDE_API_KEY")],
	["xai", () => env_available("XAI_API_KEY")],
	["deepl", () => env_available("DEEPL_API_KEY")],
	["huggingface", () => env_available("HF_TOKEN")],
	["openrouter", () => env_available("OPENROUTER_KEY")],
]);

export function get_active_provider(): ActiveProvider {
	const configured_providers: ActiveProvider[] = [];
	for (const [provider, is_configured] of provider_checks) {
		if (is_configured()) { configured_providers.push(provider); }
	}

	if (configured_providers.length === 0) {
		throw new Error("Exactly one AI provider must be configured; no provider is set");
	}

	if (configured_providers.length > 1) {
		throw new Error(`Exactly one AI provider must be configured; found: ${configured_providers.join(", ")}`);
	}

	return configured_providers[0]!;
}

// ---------------------------------------------------------------------------
// Chat query dispatcher - routes to the active provider
// ---------------------------------------------------------------------------

const chat_queries = new Map<ActiveProvider, (system_prompt: string, user_prompt: string, title: string, options: Chat_options) => Promise<string>>([
	["ollama", ollama_chat_query],
	["gemini", gemini_query],
	["openai", openai_query],
	["claude", claude_query],
	["xai", xai_query],
	["openrouter", openrouter_query],
]);

export async function chat_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: Chat_options = {}): Promise<string> {
	const provider = get_active_provider();
	const query = chat_queries.get(provider);
	if (!query) { throw new Error(`AI provider does not support chat queries: ${provider}`); }
	return query(system_prompt, user_prompt, title, options);
}

// ---------------------------------------------------------------------------
// Ollama - local LLM via OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL = "http://m4mini:11434";
const OLLAMA_DEFAULT_TIMEOUT = 300000;

async function ollama_chat_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: Chat_options = {}): Promise<string> {
	const base_url = Bun.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
	const model = options.model || Bun.env.OLLAMA_MODEL?.trim();
	if (!model) { throw new Error("OLLAMA_MODEL is not set"); }
	const { timeout = OLLAMA_DEFAULT_TIMEOUT, temperature = 0.1 } = options;

	const url = `${base_url.replace(/\/+$/, "")}/v1/chat/completions`;

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);

	const start = performance.now();
	console.log(`🦙 Ollama: ${title} - model: ${model}`);
	console.log("📤 Request sent");

	try {
		const response = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				temperature,
				thinking: { enabled: false },
				messages: [{ role: "system", content: system_prompt }, { role: "user", content: user_prompt }],
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			const elapsed = (performance.now() - start).toFixed(0);
			const err: any = new Error(`Ollama API error: ${response.status} - ${text}`);
			err.status = response.status;
			err.retry_after_ms = retry_after_ms(response.headers, text);
			console.error(`❌ Ollama error after ${elapsed}ms: ${response.status}`);
			throw err;
		}

		const json: any = await response.json();
		const content = json?.choices?.[0]?.message?.content?.trim();

		if (!content) {
			const elapsed = (performance.now() - start).toFixed(0);
			console.error(`❌ Ollama empty response after ${elapsed}ms`);
			throw new Error("Ollama returned no content");
		}

		const elapsed = (performance.now() - start).toFixed(0);
		console.log(`📥 Response received after ${elapsed}ms`);

		return content;
	} finally {
		clearTimeout(timeout_id);
	}
}

// ---------------------------------------------------------------------------
// HuggingFace Helsinki-NLP translation (text-only model, needs JSON flatten)
// ---------------------------------------------------------------------------

const HF_INFERENCE_BASE = "https://router.huggingface.co/hf-inference/models";
const HF_DEFAULT_TIMEOUT = 300000;
const HF_BATCH_SIZE = 50;

/**
 * Resolve the HF Inference API endpoint from env or language codes.
 *
 * - HF_URL: full URL override (no lang code appended)
 * - HF_MODEL: model prefix (lang code is ALWAYS appended to it)
 * - HF_MODEL is required as the model prefix
 */
function hf_endpoint(source_lang: string, target_lang: string): { url: string; model: string; } {
	const env_url = Bun.env.HF_URL?.trim();
	const env_model_prefix = Bun.env.HF_MODEL?.trim();
	const lang_code = hf_model_id(source_lang, target_lang);

	// Full URL override - use as-is (user handles the model endpoint)
	if (env_url) {
		const model = env_model_prefix ? `${env_model_prefix}-${lang_code}` : `custom-model-${lang_code}`;
		return { url: env_url, model };
	}

	// Model prefix - always append language code
	if (!env_model_prefix) { throw new Error("HF_MODEL is not set"); }
	const prefix = env_model_prefix;
	const model = `${prefix}-${lang_code}`;
	return { url: `${HF_INFERENCE_BASE}/${model}`, model };
}

// Flatten nested object into array of {path, text} leaf values
function flatten_object(obj: any, entries: { path: string[]; text: string; }[] = [], path: string[] = []): void {
	if (typeof obj === "string") {
		entries.push({ path: [...path], text: obj });
	} else if (obj && typeof obj === "object" && !Array.isArray(obj)) {
		for (const key of Object.keys(obj)) {
			flatten_object(obj[key], entries, [...path, key]);
		}
	}
}

// Reconstruct nested object from flattened entries using translated text
function reconstruct_object(original: any, translated: Map<string, string>): any {
	if (typeof original === "string") { return translated.get("") ?? original; }
	if (original && typeof original === "object" && !Array.isArray(original)) {
		const result: Record<string, any> = {};
		for (const key of Object.keys(original)) {
			const child = original[key];
			if (typeof child === "string") {
				result[key] = translated.get(key) ?? child;
			} else if (child && typeof child === "object" && !Array.isArray(child)) {
				// For nested objects, prefix keys with the parent key path
				const nested_map = new Map();
				for (const [k, v] of translated) {
					if (k === key || k.startsWith(`${key}.`)) {
						const sub_key = k === key ? "" : k.slice(key.length + 1);
						nested_map.set(sub_key, v);
					}
				}
				result[key] = reconstruct_object(child, nested_map);
			} else {
				result[key] = child;
			}
		}
		return result;
	}
	return original;
}

// Build the model ID for a language pair
function hf_model_id(source_lang: string, target_lang: string): string {
	const code = (s: string) => {
		const lower = s.trim().toLowerCase();
		if (lower.startsWith("slovenian") || lower === "slovenščina") return "sl";
		if (lower.startsWith("english") || lower === "english") return "en";
		if (lower.startsWith("french") || lower === "french" || lower === "français") return "fr";
		if (lower.startsWith("german") || lower === "german" || lower === "deutsch") return "de";
		if (lower.startsWith("spanish") || lower === "spanish" || lower === "español") return "es";
		if (lower.startsWith("italian") || lower === "italian" || lower === "italiano") return "it";
		if (lower.startsWith("croatian") || lower === "croatian" || lower === "hrvatski") return "hr";
		if (lower === "sl" || lower === "en" || lower === "fr" || lower === "de" || lower === "es" || lower === "it" || lower === "hr") { return lower; }
		throw new Error(`unknown language: ${s}`);
	};
	return `${code(source_lang)}-${code(target_lang)}`;
}

// Translate a batch of plain-text strings through Helsinki-NLP model
async function hf_batch_translate(texts: string[], source_lang: string, target_lang: string, timeout: number): Promise<string[]> {
	const { url, model } = hf_endpoint(source_lang, target_lang);

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);

	const start = performance.now();
	console.log(`🤗 ${model}: ${texts.length} strings`);
	console.log("📤 Request sent");

	try {
		// Helsinki-NLP takes a single string or array of strings
		const body = texts.length === 1 ? { inputs: texts[0] } : { inputs: texts };

		const response = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${Bun.env.HF_TOKEN!}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const text = await response.text();
			const elapsed = (performance.now() - start).toFixed(0);
			const err: any = new Error(`HuggingFace API error: ${response.status} - ${text}`);
			err.status = response.status;
			err.retry_after_ms = retry_after_ms(response.headers, text);
			console.error(`❌ HuggingFace error after ${elapsed}ms: ${response.status}`);
			throw err;
		}

		const json: any = await response.json();
		const elapsed = (performance.now() - start).toFixed(0);

		// Normalize response: HF Inference API wraps array inputs in an extra array layer
		// Single: {inputs: "text"} -> [{"translation_text": "..."}]
		// Batch:  {inputs: ["a", "b"]} -> [[{"translation_text": "..."}, {"translation_text": "..."}]]
		let results: string[] = [];

		if (Array.isArray(json)) {
			// Unwrap outer array if present (batch response format)
			const items = Array.isArray(json[0]) ? json[0] : json;

			if (items.length > 0 && typeof items[0]?.translation_text === "string") {
				results = items.map((item: any) => item.translation_text);
			} else if (typeof items === "string") {
				results = [items];
			}
		} else if (json?.translation_text) {
			results = [json.translation_text];
		}

		if (results.length > 0) {
			console.log(`📥 Response received after ${elapsed}ms`);
			return results;
		}

		console.error(`❌ HuggingFace unexpected response after ${elapsed}ms:`, JSON.stringify(json).slice(0, 200));
		throw new Error("Unexpected HuggingFace response format");
	} finally {
		clearTimeout(timeout_id);
	}
}

/**
 * Translate a JSON object using Helsinki-NLP text translation models.
 *
 * Since Helsinki-NLP only handles plain text (not JSON structure), we:
 * 1. Flatten the JSON to extract all leaf text values with their paths
 * 2. Translate in batches of HF_BATCH_SIZE
 * 3. Reconstruct the JSON with translated values
 */
export async function hf_translate_json(input: Record<string, any>, source_lang: string, target_lang: string, options: { timeout?: number; max_retries?: number; } = {}): Promise<any> {
	const { timeout = HF_DEFAULT_TIMEOUT, max_retries = 2 } = options;

	// Flatten to leaf strings
	const leaves: { path: string[]; text: string; }[] = [];
	flatten_object(input, leaves);

	console.log(`📊 HF: ${leaves.length} leaf strings to translate`);

	if (leaves.length === 0) { return { ...input }; }

	// Build a path->translation map
	const translated = new Map();

	// Process in batches
	for (let i = 0; i < leaves.length; i += HF_BATCH_SIZE) {
		const batch = leaves.slice(i, i + HF_BATCH_SIZE);
		const batch_texts = batch.map((l) => l.text);

		let last_error: Error | null = null;

		for (let attempt = 0; attempt <= max_retries; attempt++) {
			try {
				if (attempt > 0) { console.log(`🔄 HF retry ${attempt}/${max_retries}`); }

				const results = await hf_batch_translate(batch_texts, source_lang, target_lang, timeout);

				// Map results back to paths
				for (let j = 0; j < results.length; j++) {
					const key = batch[j]!.path.join(".");
					translated.set(key, results[j]);
				}
				break;
			} catch (err: any) {
				last_error = err;
				const status = err?.status;

				console.warn(`⚠️ HF batch ${Math.floor(i / HF_BATCH_SIZE) + 1} attempt ${attempt + 1} failed:`, err?.message);

				// ❌ do not retry auth/billing errors
				if (status === 401 || status === 402 || status === 403) { throw last_error; }

				if (attempt < max_retries) {
					const delay_ms = retry_delay_ms(err, 1000);
					if (status === 429) console.log(`⏳ Rate limited. Retrying in ${(delay_ms / 1000).toFixed(0)} seconds.`);
					await Bun.sleep(delay_ms);
				}
			}
		}

		if (last_error) { throw last_error; }

		// Small delay between batches
		if (i + HF_BATCH_SIZE < leaves.length) { await new Promise((r) => setTimeout(r, 300)); }
	}

	// Reconstruct the JSON
	return reconstruct_object(input, translated);
}
