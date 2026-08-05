// $lib/template.ts
import { join } from "node:path";

import { get_route_module_mounts } from "$lib/route_module";

import TemplateEngine from "./template_engine";

export function create_template_engine(is_dev: boolean = true) {
	const route_module_mounts = get_route_module_mounts();
	return new TemplateEngine({
		views: join(import.meta.dir, "..", "routes"),
		route_module_mounts,
		cache: !is_dev,
		ext: ".ree",
		auto_escape: true,
	});
}
