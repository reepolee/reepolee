/**
 * Emit translations - dev-only working-folder dump of the loaded translation
 * trees, one JSON file per language under `.reepolee/i18n/`.
 *
 * These files are NOT a source of truth (the `translations` table is). They
 * exist so the ree-templates VS Code extension can show ghost translation
 * values next to `{_ ... }` tags in `.ree` files, mirroring how ree-web reads
 * its co-located locale JSONs. Written on `bun dev` startup (bootstrap) and on
 * `/__reload-translations`; never in production.
 *
 * Each file is the full nested tree for its language exactly as
 * `translations.get(lang)` returns it (root `routes.*` plus every namespace
 * subtree). The extension resolves a template's per-route subtree from this.
 */

import { join } from "node:path";

const I18N_DIR = join(process.cwd(), ".reepolee", "i18n");

/**
 * Write one `<lang>.json` per language into `.reepolee/i18n/`.
 * `Bun.write` creates the directory tree if it does not exist.
 *
 * @param all Per-language translation trees, keyed by lang code
 *            (i.e. the `translations.all` value).
 */
export async function emit_translations(all: Record<string, any>): Promise<void> {
	const langs = Object.keys(all);

	const writes = langs.map((lang) => {
		const file_path = join(I18N_DIR, `${lang}.json`);
		const json = JSON.stringify(all[lang] ?? {}, null, 2);
		return Bun.write(file_path, `${json}\n`);
	});

	await Promise.all(writes);
}
