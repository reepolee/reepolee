import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { RouteDefinition } from "$lib/route_builder";

const MODULE_CODE = /^[a-z][a-z0-9_]*$/;

export type RouteModuleMount = {
	module_code: string;
	module_root: string;
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

export function resolve_route_module_namespace(dir: string): string | null {
	const resolved_dir = resolve(dir);
	const mounts = get_route_module_mounts();

	for (const mount of mounts) {
		const relative_dir = relative(mount.module_root, resolved_dir);
		const parent_prefix = `..${sep}`;
		const is_outside = relative_dir === ".." || relative_dir.startsWith(parent_prefix) || isAbsolute(relative_dir);
		if (is_outside) continue;

		if (!relative_dir) return mount.module_code;
		const normalized_relative_dir = relative_dir.replaceAll("\\", "/");
		return `${mount.module_code}/${normalized_relative_dir}`;
	}

	return null;
}

export async function mount_route_module(module_code: string, module_entry: string): Promise<RouteDefinition[]> {
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

	state.mounts.set(module_code, { module_code, module_root });
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
