// $lib/template.ts
import { join } from "node:path";

import TemplateEngine from "./template_engine";

export function create_template_engine(is_dev: boolean = true) {
	return new TemplateEngine({
		views: join(import.meta.dir, "..", "routes"),
		cache: !is_dev,
		ext: ".ree",
		auto_escape: true,
	});
}
