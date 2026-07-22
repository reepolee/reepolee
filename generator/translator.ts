import { count_leaves } from "$lib/translation_merge";

import { chat_query, get_active_provider, hf_translate_json } from "./ai-provider";

interface TranslateOptions {
	maxRetries?: number;
	timeout?: number;
	model?: string;
	sourceLang?: string;
}

/**
 * Walk the object tree, remove any leaf values that look like URLs (http/https),
 * push them onto a stack with their key path, and return the cleaned object.
 * The URLs are completely stripped from the result - nothing URL-related reaches the AI.
 */
function strip_urls(obj: any, entries: { keys: string[]; url: string; }[] = [], keys: string[] = []): any {
	if (typeof obj === "string" && /^https?:\/\//.test(obj)) {
		entries.push({ keys: [...keys], url: obj });
		return undefined; // signal removal to the parent
	}
	if (obj && typeof obj === "object" && !Array.isArray(obj)) {
		const result: Record<string, any> = {};
		for (const key of Object.keys(obj)) {
			const cleaned = strip_urls(obj[key], entries, [...keys, key]);
			if (cleaned !== undefined) { result[key] = cleaned; }
		}
		// If the object ended up empty after stripping URLs, prune it too
		if (Object.keys(result).length === 0) { return undefined; }
		return result;
	}
	return obj;
}

/**
 * Walk the object tree and remove empty-string leaf values.
 * Empty strings have nothing to translate - the AI is already instructed to return them as-is.
 * Also prune any parent objects that become empty as a result.
 */
function strip_empty(obj: any): any {
	if (obj && typeof obj === "object" && !Array.isArray(obj)) {
		const result: Record<string, any> = {};
		for (const key of Object.keys(obj)) {
			const cleaned = strip_empty(obj[key]);
			if (cleaned !== undefined && cleaned !== "") { result[key] = cleaned; }
		}
		if (Object.keys(result).length === 0) { return undefined; }
		return result;
	}
	return obj;
}

/**
 * Walk the translated result and insert original URLs at their original key paths.
 */
function restore_urls(obj: any, entries: { keys: string[]; url: string; }[]): any {
	for (const { keys, url } of entries) {
		let target = obj;
		for (let i = 0; i < keys.length - 1; i++) {
			if (!target[keys[i]] || typeof target[keys[i]] !== "object") { target[keys[i]] = {}; }
			target = target[keys[i]];
		}
		target[keys[keys.length - 1]] = url;
	}
	return obj;
}

export async function translate_json(input: Record<string, any>, targetLang: string, options: TranslateOptions = {}): Promise<any> {
	const { maxRetries = 2, timeout = 300000, model, sourceLang } = options;

	const source_label = sourceLang ? `${sourceLang} → ` : "";
	console.log(`🌍 translateJSON: ${source_label}${targetLang}`);

	const provider = get_active_provider();
	if (provider === "huggingface") { console.log("🤗 Using HuggingFace (HF_TOKEN set, OPENROUTER_KEY not set)"); }

	// Strip URLs from input entirely - nothing URL-related reaches the AI.
	// They are pushed onto a stack and restored after translation.
	const url_entries: { keys: string[]; url: string; }[] = [];
	const no_url_input = strip_urls(input, url_entries);

	// Log which URLs were stripped
	if (url_entries.length > 0) {
		for (const e of url_entries) {
			console.log(`🔒 Stripped URL at ${e.keys.join(".")}: ${e.url.slice(0, 40)}...`);
		}
	}

	// Also strip empty string leaves - nothing to translate
	const clean_input = no_url_input ? strip_empty(no_url_input) : undefined;

	// If nothing is left after stripping URLs and empties, skip the AI call entirely
	if (!clean_input || Object.keys(clean_input).length === 0) {
		console.log(`⏩ Nothing to translate - all values are URLs or empty strings.`);
		return restore_urls({ ...input }, url_entries);
	}

	// Fallback for type safety - clean_input is guaranteed non-empty from here
	const safe_input = clean_input as Record<string, any>;

	// HuggingFace path: flatten -> Helsinki-NLP batch translate -> reconstruct
	if (provider === "huggingface") {
		const t_start = performance.now();
		const result = await hf_translate_json(safe_input, sourceLang ?? "English", targetLang, { timeout, maxRetries });
		const t_elapsed = (performance.now() - t_start).toFixed(0);
		console.log(`✅ HF translation complete in ${t_elapsed}ms`);
		return restore_urls(result, url_entries);
	}

	// OpenRouter path: LLM handles JSON natively

	// If more than 20 keys, break into smaller chunks
	const keys = Object.keys(safe_input);
	const total_leaves = count_leaves(safe_input);
	console.log(`📊 ${keys.length} top-level keys, ${total_leaves} leaf values to translate`);

	if (keys.length > 20) {
		console.log(`📦 Breaking ${keys.length} keys into smaller chunks for translation`);
		const result = await translate_in_chunks(
			safe_input,
			targetLang,
			sourceLang,
			model,
			timeout,
			maxRetries
		);
		return restore_urls(result, url_entries);
	}

	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			if (attempt > 0) { console.log(`🔄 Retry attempt ${attempt}/${maxRetries}`); }

			const t_start = performance.now();
			const result = await translate_attempt(safe_input, targetLang, sourceLang, model, timeout);
			const t_elapsed = (performance.now() - t_start).toFixed(0);

			const result_leaves = count_leaves(result);
			console.log(`✅ Translation complete in ${t_elapsed}ms - ${result_leaves} leaf values in response`);

			return restore_urls(result, url_entries);
		} catch (err: any) {
			lastError = err;

			const status = err?.status;

			console.warn(`⚠️ Attempt ${attempt + 1} failed:`, err?.message);

			// ❌ do not retry auth/billing errors
			if (status === 401 || status === 402 || status === 403) { break; }

			// retry backoff
			if (attempt < maxRetries) { await new Promise((r) => setTimeout(r, 800)); }
		}
	}

	throw lastError || new Error("Translation failed after retries");
}

/**
 * Single attempt
 */
async function translate_attempt(
	input: Record<string, any>,
	targetLang: string,
	sourceLang: string | undefined,
	model: string,
	timeout: number,
): Promise<any> {
	const system_prompt = SYSTEM_PROMPT;
	const user_prompt = `${sourceLang ? `Translate from ${sourceLang} to ${targetLang}.` : `Translate to ${targetLang}.`} Keep structure identical. Only translate leaf values:\n\n${JSON.stringify(
		input,
		null,
		2
	)}`;

	console.log(`📝 Prompt: ${sourceLang ?? "?"} → ${targetLang}, ${user_prompt.length} characters`);

	const text = await chat_query(system_prompt, user_prompt, "JSON Translator", { model, timeout });

	return parse_and_repair(text);
}

/**
 * Break input into chunks and translate each chunk separately
 */
async function translate_in_chunks(
	input: Record<string, any>,
	targetLang: string,
	sourceLang: string | undefined,
	model: string | undefined,
	timeout: number,
	maxRetries: number,
): Promise<any> {
	const keys = Object.keys(input);
	const chunkSize = 20;
	const chunks: Record<string, any>[] = [];

	// Split keys into chunks of 20
	for (let i = 0; i < keys.length; i += chunkSize) {
		const chunkKeys = keys.slice(i, i + chunkSize);
		const chunk: Record<string, any> = {};
		for (const key of chunkKeys) {
			chunk[key] = input[key];
		}
		chunks.push(chunk);
	}

	console.log(`📦 Translating ${chunks.length} chunk(s)`);

	const translatedChunks: Record<string, any>[] = [];

	for (let i = 0; i < chunks.length; i++) {
		console.log(`📦 Translating chunk ${i + 1}/${chunks.length} (${Object.keys(chunks[i]).length} keys)`);

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) { console.log(`🔄 Retry attempt ${attempt}/${maxRetries} for chunk ${i + 1}`); }

				const translated = await translate_attempt(chunks[i], targetLang, sourceLang, model, timeout);
				translatedChunks.push(translated);
				break;
			} catch (err: any) {
				lastError = err;

				const status = err?.status;

				console.warn(`⚠️ Chunk ${i + 1} attempt ${attempt + 1} failed:`, err?.message);

				// ❌ do not retry auth/billing errors
				if (status === 401 || status === 402 || status === 403) { throw lastError; }

				// retry backoff
				if (attempt < maxRetries) { await new Promise((r) => setTimeout(r, 800)); }
			}
		}

		if (lastError && !translatedChunks.includes(lastError as any)) { throw lastError; }

		// Small delay between chunks to avoid rate limiting
		if (i < chunks.length - 1) { await new Promise((r) => setTimeout(r, 300)); }
	}

	// Merge all translated chunks
	const result: Record<string, any> = {};
	for (const chunk of translatedChunks) {
		Object.assign(result, chunk);
	}

	return result;
}

/**
 * System prompt (strict JSON mode)
 */
const SYSTEM_PROMPT = `
You are a precise JSON translator.

CRITICAL RULES:
- Output ONLY valid JSON
- No markdown
- No explanation
- Keep structure identical
- Only translate leaf string values
- Do NOT add or remove keys
- Ensure all quotes are closed
- No trailing commas
- Do NOT translate empty string values (e.g., "") - keep them as empty strings, this is intentional
- For keys named "route_name", ALWAYS translate the value even if it looks like a URL path - these are route identifiers, not URLs
- Do NOT wrap translated values in extra quotation marks (e.g., avoid ""value"" - use "value" instead)

Return valid JSON only.
`.trim();

/**
 * Robust JSON parser + repair pipeline
 */
function parse_and_repair(text: string): any {
	text = text.trim();

	// remove markdown fences
	text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

	// fast path
	try {
		return JSON.parse(text);
	} catch {}

	// extract JSON block
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) { throw new Error("No JSON object found in response"); }

	let repaired = match[0];

	// fix trailing commas
	repaired = repaired.replace(/,(\s*[}\]])/g, "$1");

	// normalize quotes
	repaired = repaired.replace(/""+/g, "\"");

	// balance braces (basic recovery)
	const open = (repaired.match(/\{/g) || []).length;
	const close = (repaired.match(/\}/g) || []).length;

	if (open > close) { repaired += "}".repeat(open - close); }

	try {
		return JSON.parse(repaired);
	} catch (e) {
		console.error("❌ Original output:\n", text);
		console.error("❌ Repaired output:\n", repaired);
		throw new Error(`JSON repair failed: ${(e as Error).message}`);
	}
}
