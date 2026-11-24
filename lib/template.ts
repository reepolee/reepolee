// $lib/template.ts
import { join } from "node:path";

import { APPS_DIR, PLATFORM_DIR } from "$config/paths";
import { default_locale, locales } from "$config/supported_locales";
import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";
import { stamp_ree_i18n, stamp_ree_source } from "$lib/inspector_stamp";
import { get_route_module_mounts } from "$lib/route_module";

import TemplateEngine from "./template_engine";

/**
 * Dev inspector stamping: block-level data-ree line stamps, then i18n wrapper
 * spans around {_ }/{- } lookups. Block stamping runs first so its line numbers
 * come from the original layout; the i18n pass only touches {_ }/{- } tokens,
 * which block stamping never altered.
 */
function stamp_dev_source(raw: string, rel_path: string): string {
	const block_stamped = stamp_ree_source(raw, rel_path);
	return stamp_ree_i18n(block_stamped, rel_path);
}

export function create_template_engine(is_dev: boolean = true) {
	const route_module_mounts = get_route_module_mounts();
	const project_root = join(import.meta.dir, "..");
	return new TemplateEngine({
		views: join(project_root, APPS_DIR),
		shared_views: join(project_root, PLATFORM_DIR),
		project_root,
		route_module_mounts,
		cache: !is_dev,
		ext: ".ree",
		auto_escape: true,
		locales,
		default_locale,
		helper_names: DEFAULT_HELPER_NAMES,
		transform_source: stamp_dev_source,
	});
}
