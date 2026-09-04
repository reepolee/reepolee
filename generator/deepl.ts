import { retry_after_ms, retry_delay_ms } from "./retry_after";

const DEEPL_FREE_API_URL = "https://api-free.deepl.com/v2/translate";
const DEEPL_BATCH_SIZE = 50;
const DEEPL_DEFAULT_TIMEOUT = 300000;

type TranslationEntry = { path: string[]; text: string; };

export function deepl_language_code(locale_code: string, target: boolean): string {
	// `locale_code` must be a BCP 47 code ("de-de", "en-us") - callers pass the
	// codes from config/supported_locales.ts straight through. Display names
	// ("German (Germany)") fail the strict 2-3 letter language check below;
	// DeepL only accepts codes.
	const normalized = locale_code.trim().toLowerCase();
	const locale_parts = normalized.split("-");
	const language_code = locale_parts[0]?.toUpperCase();
	if (!language_code || !/^[A-Z]{2,3}$/.test(language_code)) throw new Error(`DeepL does not recognize language or locale: ${locale_code}`);

	if (target && language_code === "EN" && locale_parts[1]) return `EN-${locale_parts[1].toUpperCase()}`;
	return language_code;
}

function flatten_object(value: unknown, entries: TranslationEntry[] = [], path: string[] = []): TranslationEntry[] {
	if (typeof value === "string") {
		entries.push({ path, text: value });
		return entries;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value)) flatten_object(child, entries, [...path, key]);
	}
	return entries;
}

function set_path(result: Record<string, unknown>, path: string[], value: string): void {
	let target: Record<string, unknown> = result;
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index]!;
		const child = target[key];
		if (!child || typeof child !== "object" || Array.isArray(child)) target[key] = {};
		target = target[key] as Record<string, unknown>;
	}
	target[path[path.length - 1]!] = value;
}

async function translate_batch(texts: string[], source_lang: string, target_lang: string, timeout: number, max_retries: number): Promise<string[]> {
	const api_key = Bun.env.DEEPL_API_KEY?.trim();
	if (!api_key) throw new Error("DEEPL_API_KEY is not set");
	let last_error: Error | null = null;

	for (let attempt = 0; attempt <= max_retries; attempt++) {
		const controller = new AbortController();
		const timeout_id = setTimeout(() => controller.abort(), timeout);
		try {
			const response = await fetch(DEEPL_FREE_API_URL, {
				method: "POST",
				signal: controller.signal,
				headers: {
					Authorization: `DeepL-Auth-Key ${api_key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: texts, source_lang, target_lang }),
			});
			if (!response.ok) {
				const body = await response.text();
				const error: any = new Error(`DeepL API error: ${response.status} - ${body}`);
				error.status = response.status;
				error.retry_after_ms = retry_after_ms(response.headers, body);
				throw error;
			}

			const body = await response.json() as { translations?: Array<{ text?: string; }>; };
			const translations = body.translations?.map((entry) => entry.text);
			if (!translations || translations.length !== texts.length || translations.some((text) => typeof text !== "string")) {
				throw new Error("DeepL returned an incomplete translation response");
			}
			return translations as string[];
		} catch (error: any) {
			last_error = error;
			if (error?.status === 401 || error?.status === 403 || attempt === max_retries) break;
			const delay_ms = retry_delay_ms(error, 800);
			if (error?.status === 429) console.log(`⏳ DeepL rate limited. Retrying in ${(delay_ms / 1000).toFixed(0)} seconds.`);
			await Bun.sleep(delay_ms);
		} finally {
			clearTimeout(timeout_id);
		}
	}

	throw last_error ?? new Error("DeepL translation failed");
}

export async function deepl_translate_json(input: Record<string, unknown>, source_language: string, target_language: string, options: { timeout?: number; max_retries?: number; } = {}): Promise<Record<string, unknown>> {
	const { timeout = DEEPL_DEFAULT_TIMEOUT, max_retries = 2 } = options;
	const entries = flatten_object(input);
	const source_lang = deepl_language_code(source_language, false);
	const target_lang = deepl_language_code(target_language, true);
	const result: Record<string, unknown> = {};

	for (let offset = 0; offset < entries.length; offset += DEEPL_BATCH_SIZE) {
		const batch = entries.slice(offset, offset + DEEPL_BATCH_SIZE);
		const texts = batch.map((entry) => entry.text);
		const translations = await translate_batch(texts, source_lang, target_lang, timeout, max_retries);
		for (let index = 0; index < batch.length; index++) set_path(result, batch[index]!.path, translations[index]!);
	}

	return result;
}
