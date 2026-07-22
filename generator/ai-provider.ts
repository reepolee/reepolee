/**
 * AI provider abstraction for generator scripts.
 *
 * Supports:
 * - Ollama (local LLM via OpenAI-compatible endpoint) - highest priority
 * - Gemini (Google Generative Language API)
 * - HuggingFace (via Helsinki-NLP translation models on HF Inference API)
 * - OpenRouter (cloud LLM) - default fallback
 *
 * Provider selection priority:
 * 1. OLLAMA_URL set -> Ollama
 * 2. GEMINI_API_KEY set -> Gemini
 * 3. HF_TOKEN set and OPENROUTER_KEY not set -> HuggingFace
 * 4. Otherwise -> OpenRouter
 */

import { openrouter_query } from "./openrouter";
import { gemini_query } from "./gemini";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export type ActiveProvider = "openrouter" | "huggingface" | "ollama" | "gemini";

export function get_active_provider(): ActiveProvider {
	// 1. Local Ollama takes priority
	if (Bun.env.OLLAMA_URL?.trim()) { return "ollama"; }

	// 2. Gemini when its API key is set
	if (Bun.env.GEMINI_API_KEY?.trim()) { return "gemini"; }

	// 3. HuggingFace when HF_TOKEN is set and OpenRouter is not
	const hf_token = Bun.env.HF_TOKEN?.trim();
	const or_key = Bun.env.OPENROUTER_KEY?.trim();

	if (hf_token && !or_key) { return "huggingface"; }

	// 4. Default: OpenRouter
	return "openrouter";
}

// ---------------------------------------------------------------------------
// Chat query dispatcher - routes to the active provider
// ---------------------------------------------------------------------------

export async function chat_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: { model?: string; timeout?: number; temperature?: number; } = {}): Promise<string> {
	const provider = get_active_provider();

	if (provider === "ollama") { return ollama_chat_query(system_prompt, user_prompt, title, options); }
	if (provider === "gemini") { return gemini_query(system_prompt, user_prompt, title, options); }

	// HF doesn't go through chat_query - it's handled via hf_translate_json directly.
	// If not Ollama/Gemini, use OpenRouter (default).
	return openrouter_query(system_prompt, user_prompt, title, options);
}

// ---------------------------------------------------------------------------
// Ollama - local LLM via OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL = "http://m4mini:11434";
const DEFAULT_OLLAMA_MODEL = "gemma4:e4b";
const OLLAMA_DEFAULT_TIMEOUT = 300000;

async function ollama_chat_query(system_prompt: string, user_prompt: string, title: string = "AI Query", options: { model?: string; timeout?: number; temperature?: number; } = {}): Promise<string> {
	const base_url = Bun.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
	const model = options.model || Bun.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
	const { timeout = OLLAMA_DEFAULT_TIMEOUT, temperature = 0.1 } = options;

	const url = `${base_url.replace(/\/+$/, "")}/v1/chat/completions`;

	const controller = new AbortController();
	const timeout_id = setTimeout(() => controller.abort(), timeout);

	const start = performance.now();
	console.log(`🦙 Ollama: ${title} - model: ${model}`);
	console.log(`📤 JSON sent:\n${user_prompt}`);

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
		console.log(`📥 JSON received after ${elapsed}ms:\n${content.slice(0, 2000)}`);

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

const DEFAULT_HF_MODEL_PREFIX = "Helsinki-NLP/opus-mt";

/**
 * Resolve the HF Inference API endpoint from env or language codes.
 *
 * - HF_URL: full URL override (no lang code appended)
 * - HF_MODEL: model prefix (lang code is ALWAYS appended to it)
 * - Neither: default to Helsinki-NLP/opus-mt-{lang_code}
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
	const prefix = env_model_prefix || DEFAULT_HF_MODEL_PREFIX;
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
	console.log(`📤 JSON sent:\n${JSON.stringify(texts, null, 2)}`);

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
			console.log(`📥 JSON received after ${elapsed}ms:\n${JSON.stringify(results, null, 2).slice(0, 2000)}`);
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
export async function hf_translate_json(input: Record<string, any>, source_lang: string, target_lang: string, options: { timeout?: number; maxRetries?: number; } = {}): Promise<any> {
	const { timeout = HF_DEFAULT_TIMEOUT, maxRetries = 2 } = options;

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

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) { console.log(`🔄 HF retry ${attempt}/${maxRetries}`); }

				const results = await hf_batch_translate(batch_texts, source_lang, target_lang, timeout);

				// Map results back to paths
				for (let j = 0; j < results.length; j++) {
					const key = batch[j].path.join(".");
					translated.set(key, results[j]);
				}
				break;
			} catch (err: any) {
				lastError = err;
				const status = err?.status;

				console.warn(`⚠️ HF batch ${Math.floor(i / HF_BATCH_SIZE) + 1} attempt ${attempt + 1} failed:`, err?.message);

				// ❌ do not retry auth/billing errors
				if (status === 401 || status === 402 || status === 403) { throw lastError; }

				if (attempt < maxRetries) { await new Promise((r) => setTimeout(r, 1000)); }
			}
		}

		if (lastError) { throw lastError; }

		// Small delay between batches
		if (i + HF_BATCH_SIZE < leaves.length) { await new Promise((r) => setTimeout(r, 300)); }
	}

	// Reconstruct the JSON
	return reconstruct_object(input, translated);
}
