#!/usr/bin/env bun
/**
 * One-time dev-DB migration for the locale switch (pre-1.0, no backwards
 * compatibility).
 *
 * Default mode: rebuilds the `translations` table keyed by `locale`
 * (BCP 47, e.g. "en-us") instead of `lang` ("en"), remapping existing rows.
 *
 * `--lowercase` mode: rewrites existing mixed-case locale values ("en-US",
 * "sl-SI") to the lowercase canonical form ("en-us", "sl-si"), because the
 * app's canonical identity is all-lowercase everywhere (config, DB keys,
 * URLs, comparisons). Also lowercases the locale embedded in
 * `ui.locale_names.*` / `ui.language_names_to.*` key paths.
 *
 * Usage:
 *   bun scripts/migrate_locales.ts <path-to-sqlite-db> [more-dbs...]
 *   bun scripts/migrate_locales.ts --lowercase <path-to-sqlite-db> [more-dbs...]
 * A `.bak-locales` copy of each file is written before touching it.
 */
import { copyFileSync, existsSync } from "node:fs";

import { SQL } from "bun";

// Old bare language codes -> locales (the retired language_locales map).
const LANG_TO_LOCALE: Record<string, string> = { en: "en-us", sl: "sl-si" };

const args = Bun.argv.slice(2);
const lowercase_mode = args.includes("--lowercase");
const targets = args.filter((arg) => arg !== "--lowercase");

if (targets.length === 0) {
	console.error("Usage: bun scripts/migrate_locales.ts [--lowercase] <sqlite-db-file> [more...]");
	process.exit(1);
}

for (const target of targets) {
	if (!existsSync(target)) {
		console.error(`[migrate-locales] ${target}: not found, skipping`);
		continue;
	}
	copyFileSync(target, `${target}.bak-locales`);
	const db = new SQL(`sqlite://${target}`);

	if (lowercase_mode) {
		// Rebuild the table like the other mode does, so the
		// UNIQUE(locale, namespace, key_path) constraint can never reject a
		// row that two mixed-case rows collide into after lowercasing.
		await db.unsafe(`CREATE TABLE translations_new (
			id          INTEGER   PRIMARY KEY,
			locale      TEXT      NOT NULL,
			namespace   TEXT      NOT NULL DEFAULT '',
			key_path    TEXT      NOT NULL,
			translation TEXT      NOT NULL DEFAULT '',
			display     TEXT      GENERATED ALWAYS AS (locale || ':' || namespace || ':' || key_path) VIRTUAL,
			created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(locale, namespace, key_path)
		)`);

		await db.unsafe(`INSERT OR IGNORE INTO translations_new (id, locale, namespace, key_path, translation, created_at, updated_at)
			SELECT MIN(id),
				LOWER(locale),
				namespace,
				CASE
					WHEN key_path LIKE 'ui.locale_names.%' THEN 'ui.locale_names.' || LOWER(SUBSTR(key_path, 17))
					WHEN key_path LIKE 'ui.language_names_to.%' THEN 'ui.language_names_to.' || LOWER(SUBSTR(key_path, 22))
					ELSE key_path
				END,
				translation,
				MIN(created_at),
				MAX(updated_at)
			FROM translations
			GROUP BY LOWER(locale), namespace, key_path`);

		await db.unsafe(`DROP TABLE translations`);
		await db.unsafe(`ALTER TABLE translations_new RENAME TO translations`);
		await db.unsafe(`CREATE TRIGGER translations_updated_at_trigger AFTER UPDATE ON translations FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE translations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);

		const count = await db.unsafe(`SELECT COUNT(*) AS n, COUNT(DISTINCT locale) AS l FROM translations`);
		console.log(`[migrate-locales] ${target}: lowercased ${count[0].n} rows across ${count[0].l} locale(s)`);
		await db.close();
		continue;
	}

	const has_lang = await db.unsafe(`SELECT 1 FROM pragma_table_info('translations') WHERE name = 'lang' LIMIT 1`);
	if (!has_lang || has_lang.length === 0) {
		console.log(`[migrate-locales] ${target}: translations already keyed by locale, skipping`);
		await db.close();
		continue;
	}

	await db.unsafe(`CREATE TABLE translations_new (
		id          INTEGER   PRIMARY KEY,
		locale      TEXT      NOT NULL,
		namespace   TEXT      NOT NULL DEFAULT '',
		key_path    TEXT      NOT NULL,
		translation TEXT      NOT NULL DEFAULT '',
		display     TEXT      GENERATED ALWAYS AS (locale || ':' || namespace || ':' || key_path) VIRTUAL,
		created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(locale, namespace, key_path)
	)`);

	const case_pairs = Object.entries(LANG_TO_LOCALE).map(([lang, locale]) => `WHEN '${lang}' THEN '${locale}'`).join(" ");
	await db.unsafe(`INSERT OR IGNORE INTO translations_new (id, locale, namespace, key_path, translation, created_at, updated_at)
		SELECT id, CASE lang ${case_pairs} ELSE lang END, namespace, key_path, translation, created_at, updated_at FROM translations`);

	await db.unsafe(`DROP TABLE translations`);
	await db.unsafe(`ALTER TABLE translations_new RENAME TO translations`);
	await db.unsafe(`CREATE TRIGGER translations_updated_at_trigger AFTER UPDATE ON translations FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE translations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);

	const count = await db.unsafe(`SELECT COUNT(*) AS n, COUNT(DISTINCT locale) AS l FROM translations`);
	console.log(`[migrate-locales] ${target}: migrated ${count[0].n} rows across ${count[0].l} locale(s)`);
	await db.close();
}
