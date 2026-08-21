import { notify_server_reload } from "$lib/server_notify";
import { get_dotted, read_namespace_file, upsert_file_translation } from "$lib/translation_files";

import { color, GREEN } from "../ui";
import { default_locale } from "$config/supported_locales";

export async function sync_nav_translation(nav_key: string, label: string): Promise<void> {
	const { locales } = await import("$config/supported_locales");

	for (const locale of locales) {
		await upsert_file_translation(locale, nav_key, "nav", label);
	}
	console.log(`  ${color("✓", GREEN)} Synced nav.${nav_key} to files`);
}

export async function sync_prefix_title(clean_prefix: string): Promise<void> {
	if (!clean_prefix) return;

	const obj = await read_namespace_file(clean_prefix, default_locale);
	if (get_dotted(obj, "nav_prefix_title") === undefined) {
		const underscore_replaced = clean_prefix.replace(/_/g, " ");
		const prefix_raw = underscore_replaced.replace(/-/g, " ");
		const prefix_label = prefix_raw.charAt(0).toUpperCase() + prefix_raw.slice(1);
		await upsert_file_translation(default_locale, clean_prefix, "nav_prefix_title", prefix_label);
		console.log(`  ${color("✓", GREEN)} Synced nav_prefix_title.${clean_prefix} to files`);
	}
}

export async function finalize_routes_update(routes_path: string, _deferred_routes_content: string | null): Promise<void> {
	if (_deferred_routes_content) {
		await Bun.write(routes_path, _deferred_routes_content);
		console.log(`  ${color("✓", GREEN)} Updated routes.ts`);
	}
	await notify_server_reload();
}
