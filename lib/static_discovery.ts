/**
 * Route-local static discovery - walks a routes directory tree and mounted
 * development route modules to collect every `static/` subfolder found.
 *
 * Assets are served flat at root (apps/reeman/studio/static/studio.js -> /studio.js),
 * matching how the top-level static/ dir already behaves.
 */

import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { get_route_module_mounts } from "$lib/route_module";
import { MAIN_APP } from "$config/paths";

export function discover_route_static_dirs(routes_root: string): string[] {
	const found: string[] = [];

	const walk = (dir: string): void => {
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = join(dir, entry.name);
			if (entry.name === "static") {
				found.push(full);
				continue;
			}
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			walk(full);
		}
	};

	walk(routes_root);
	return found;
}

export function discover_static_dirs(project_root: string, routes_folder: string = MAIN_APP): string[] {
	const static_dirs = [join(project_root, "static")];
	const routes_root = join(project_root, routes_folder);
	const route_static_dirs = discover_route_static_dirs(routes_root);
	static_dirs.push(...route_static_dirs);

	const route_module_mounts = get_route_module_mounts();
	for (const mount of route_module_mounts) {
		const module_static_dirs = discover_route_static_dirs(mount.module_root);
		static_dirs.push(...module_static_dirs);
	}

	return static_dirs;
}
