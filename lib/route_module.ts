import { existsSync, readdirSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RouteDefinition } from "$lib/route_builder";

const MODULE_CODE = /^[a-z][a-z0-9_]*$/;

export type RouteModuleMount = {
	module_code: string;
	module_root: string;
	namespace_prefix?: string;
};

type RouteModuleState = {
	mounts: Map<string, RouteModuleMount>;
	version: number;
};

declare global {
	var __reepolee_route_module_state: RouteModuleState | undefined;
}

function route_module_state(): RouteModuleState {
	if (!globalThis.__reepolee_route_module_state) {
		globalThis.__reepolee_route_module_state = { mounts: new Map(), version: 0 };
	}
	return globalThis.__reepolee_route_module_state;
}

export function reset_route_module_mounts(): void {
	const state = route_module_state();
	state.mounts.clear();
	state.version++;
}

export function get_route_module_mounts(): RouteModuleMount[] {
	const state = route_module_state();
	return Array.from(state.mounts.values(), (mount) => ({ ...mount }));
}

export function get_route_module_mount_version(): number {
	return route_module_state().version;
}

function mounted_module_relative_dir(dir: string): { mount: RouteModuleMount; relative_dir: string; } | null {
	const resolved_dir = resolve(dir);
	const mounts = get_route_module_mounts();

	for (const mount of mounts) {
		const relative_dir = relative(mount.module_root, resolved_dir);
		const parent_prefix = `..${sep}`;
		const is_outside = relative_dir === ".." || relative_dir.startsWith(parent_prefix) || isAbsolute(relative_dir);
		if (!is_outside) return { mount, relative_dir };
	}

	return null;
}

export function resolve_route_module_namespace(dir: string): string | null {
	const mounted = mounted_module_relative_dir(dir);
	if (!mounted) return null;

	const { mount, relative_dir } = mounted;
	const namespace_root = mount.namespace_prefix ? `${mount.namespace_prefix}/` : "";
	if (!relative_dir) return `${namespace_root}${mount.module_code}`;
	const normalized_relative_dir = relative_dir.replaceAll("\\", "/");
	return `${namespace_root}${mount.module_code}/${normalized_relative_dir}`;
}

/**
 * Resolve the template path for a mounted module from the apps/ views root.
 * A module's namespace prefix is its app directory, so templates under
 * apps/reeman/db_tables resolve as reeman/db_tables.
 */
export function resolve_route_module_template_namespace(dir: string): string | null {
	const mounted = mounted_module_relative_dir(dir);
	if (!mounted) return null;

	const { mount, relative_dir } = mounted;
	const app_prefix = mount.namespace_prefix ? `${mount.namespace_prefix}/` : "";
	const module_path = `${app_prefix}${mount.module_code}`;
	if (!relative_dir) return module_path;
	return `${module_path}/${relative_dir.replaceAll("\\", "/")}`;
}

export async function mount_route_module(module_code: string, module_entry: string, namespace_prefix: string = ""): Promise<RouteDefinition[]> {
	if (!MODULE_CODE.test(module_code)) {
		throw new Error(`Route module code must be snake_case and start with a letter: ${module_code}`);
	}

	const state = route_module_state();
	if (state.mounts.has(module_code)) {
		throw new Error(`Route module is already mounted: ${module_code}`);
	}

	const entry_url = new URL(module_entry);
	if (entry_url.protocol !== "file:") {
		throw new Error(`Route module entry must be a file URL: ${module_entry}`);
	}

	const entry_path = fileURLToPath(entry_url);
	const module_root = resolve(dirname(entry_path));
	const mounts = get_route_module_mounts();
	const duplicate_root = mounts.find((mount) => mount.module_root === module_root);
	if (duplicate_root) {
		throw new Error(`Route module root is already mounted as ${duplicate_root.module_code}: ${module_root}`);
	}

	const imported_module = await import(module_entry);
	const route_definitions: unknown = imported_module.route_definitions;
	if (!Array.isArray(route_definitions)) {
		throw new Error(`Route module must export route_definitions: ${module_entry}`);
	}

	state.mounts.set(module_code, {
		module_code,
		module_root,
		...(namespace_prefix ? { namespace_prefix } : {}),
	});
	state.version++;
	return route_definitions as RouteDefinition[];
}

export async function try_load_routes(path: string): Promise<RouteDefinition[]> {
	try {
		const mod = await import(path);
		return mod.route_definitions ?? [];
	} catch {
		return [];
	}
}

/**
 * Mount every first-level subfolder of `dir` that has an `index.ts` as a route
 * module named after the folder. Returns the concatenated route definitions.
 *
 * Used by first-party app folders (apps/reeman/, apps/reeqa/) so every module
 * is mounted by default. Its templates resolve through the mount root and
 * `route_namespace_from_dir()` resolves its translation namespace to the
 * optional prefix plus folder name - without hand-wiring each new module into
 * the routes file.
 */
export async function mount_route_modules_from_dir(dir: string, namespace_prefix: string = ""): Promise<RouteDefinition[]> {
	const definitions: RouteDefinition[] = [];

	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return definitions;
	}

	const staged_mounts = new Map<string, RouteModuleMount>();
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (!MODULE_CODE.test(entry.name)) throw new Error(`Route module code must be snake_case and start with a letter: ${entry.name}`);

		const index_path = join(dir, entry.name, "index.ts");
		if (!existsSync(index_path)) continue;
		const module_entry = pathToFileURL(index_path).href;
		const imported_module = await import(module_entry);
		const defs: unknown = imported_module.route_definitions;
		if (!Array.isArray(defs)) throw new Error(`Route module must export route_definitions: ${module_entry}`);
		const module_root = resolve(dirname(index_path));
		staged_mounts.set(entry.name, {
			module_code: entry.name,
			module_root,
			...(namespace_prefix ? { namespace_prefix } : {}),
		});
		definitions.push(...defs);
	}
	const state = route_module_state();
	state.mounts = staged_mounts;
	state.version++;

	return definitions;
}
