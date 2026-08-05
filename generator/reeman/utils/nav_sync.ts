import { db_cli } from "$config/db_cli";
import { notify_server_reload } from "$lib/server_notify";

import { color, dim, GREEN } from "../ui";
import { default_locale } from "$config/supported_locales";

export async function sync_nav_translation(nav_key: string, label: string): Promise<void> {
	try {
		const { locales } = await import("$config/supported_locales");

		for (const locale of locales) {
			await db_cli`DELETE FROM translations WHERE locale = ${locale} AND namespace = ${nav_key} AND key_path = 'nav'`;
			await db_cli`INSERT INTO translations (locale, namespace, key_path, translation) VALUES (${locale}, ${nav_key}, 'nav', ${label})`;
		}
		console.log(`  ${color("✓", GREEN)} Synced nav.${nav_key} to DB`);
	} catch {
		console.log(`  ${dim("  (DB not available - nav translation not synced)")}`);
	}
}

export async function sync_prefix_title(clean_prefix: string): Promise<void> {
	if (!clean_prefix) return;

	try {
		const existing = (await db_cli`SELECT 1 FROM translations WHERE locale = ${default_locale} AND namespace = ${clean_prefix} AND key_path = 'nav_prefix_title' LIMIT 1`) as any[];
		if (existing.length === 0) {
			const prefix_raw = clean_prefix.replace(/_/g, " ").replace(/-/g, " ");
			const prefix_label = prefix_raw.charAt(0).toUpperCase() + prefix_raw.slice(1);
			await db_cli`INSERT INTO translations (locale, namespace, key_path, translation) VALUES (${default_locale}, ${clean_prefix}, 'nav_prefix_title', ${prefix_label})`;
			console.log(`  ${color("✓", GREEN)} Synced nav_prefix_title.${clean_prefix} to DB`);
		}
	} catch {
		console.log(`  ${dim("  (DB not available - nav prefix title not synced)")}`);
	}
}

export async function finalize_routes_update(routes_path: string, _deferred_routes_content: string | null): Promise<void> {
	if (_deferred_routes_content) {
		await Bun.write(routes_path, _deferred_routes_content);
		console.log(`  ${color("✓", GREEN)} Updated routes.ts`);
	}
	await notify_server_reload();
}
