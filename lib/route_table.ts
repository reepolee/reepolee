/**
 * Route Table - global mutable route state that survives `--hot` reloads.
 *
 * Bun's `--hot` re-evaluates modules on file change, but globalThis persists.
 * This module stores the route table, nav routes, middleware config, and
 * base template data on globalThis so hot reloads can rebuild routes in-place
 * without restarting the Bun.serve() instance.
 *
 * The server fetch handler reads from this registry on every request, so
 * updates to the route table are picked up immediately - no server restart needed.
 */

import type { RouteHandler, RouteTable } from "$lib/middleware/types";
import { match_pattern } from "$lib/url_pattern";
import type { NavRoute } from "$lib/route_builder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NavSection = { key: string; title_key: string; items: NavRoute[]; order: number | null; };
export type NavGroup = { label: string; items: NavRoute[]; sections: NavSection[]; order: number | null; };

interface RouteState {
	routes: RouteTable;
	nav_routes: NavRoute[];
	nav_groups: NavGroup[];
	base_data: Record<string, any>;
	middleware: unknown[];
	version: number;
}

declare global {
	var __reepolee_route_state: RouteState | undefined;
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

function default_state(): RouteState {
	return { routes: {}, nav_routes: [], nav_groups: [], base_data: {}, middleware: [], version: 0 };
}

// ---------------------------------------------------------------------------
// Accessors - all read/write from globalThis
// ---------------------------------------------------------------------------

function state(): RouteState {
	if (!globalThis.__reepolee_route_state) { globalThis.__reepolee_route_state = default_state(); }
	return globalThis.__reepolee_route_state;
}

export function get_route_table(): RouteTable { return state().routes; }

export function set_route_table(table: RouteTable): void {
	state().routes = table;
	state().version++;
}

export function set_nav_routes(nav: NavRoute[]): void { state().nav_routes = nav; }

export function set_nav_groups(groups: NavGroup[]): void { state().nav_groups = groups; }

export function get_base_data(): Record<string, any> { return state().base_data; }

export function set_base_data(data: Record<string, any>): void { state().base_data = data; }

// ---------------------------------------------------------------------------
// Check if this is the first run or a --hot re-evaluation
// ---------------------------------------------------------------------------

export function is_first_run(): boolean { return !globalThis.__reepolee_route_state; }

/**
 * Mark that first-run initialization has completed.
 */
export function mark_initialized(): void { globalThis.__reepolee_route_state = globalThis.__reepolee_route_state ?? default_state(); }

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/**
 * Match a URL pathname against the route table.
 * Returns `{ handler, params }` for the first matching route, or null.
 * `params` is populated from :param segments in the pattern (matches Bun's
 * native radix-tree behaviour so handlers can read `req.params.x`).
 * Handles trailing-slash normalization and :param pattern segments.
 */
export function match_route(pathname: string, table: RouteTable): { handler: RouteHandler; params: Record<string, string>; } | null {
	// 1. Trailing slash normalization - strip trailing / to match canonical entry
	// The route table stores N entries (not 2N), so /about/ -> /about, /users/123/ -> /users/123
	const normalized = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

	// 2. Exact match
	const exact = table[normalized];
	if (exact) return { handler: exact, params: {} };

	// 3. Pattern match for :param segments
	for (const [pattern, handler] of Object.entries(table)) {
		if (!pattern.includes(":")) continue;

		const params = match_pattern(pattern, normalized);
		if (params) return { handler, params };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Nav group builder
// ---------------------------------------------------------------------------

/**
 * Build nav groups from nav_routes - groups menu entries by module tag.
 * Untagged entries come first, then tagged groups alphabetically.
 */
export function build_nav_groups(nav_routes: NavRoute[]): NavGroup[] {
	const menu_entries = nav_routes.filter((e) => e.is_menu_entry);
	const groups = new Map<string, NavGroup>();
	const section_orders = new Map<string, number | null>();

	for (const entry of menu_entries) {
		const module_key = entry.module ?? "";
		let group = groups.get(module_key);
		if (!group) {
			const label = entry.module ? entry.module.toLowerCase() : "";
			group = { label, items: [], sections: [], order: entry.nav_group_order ?? null };
			groups.set(module_key, group);
		} else if (group.order !== (entry.nav_group_order ?? null) && group.order !== null && entry.nav_group_order !== null && entry.nav_group_order !== undefined) {
			throw new Error(`build_nav_groups: conflicting nav_group_order values for "${module_key}"`);
		} else if (group.order === null && entry.nav_group_order !== null && entry.nav_group_order !== undefined) {
			group.order = entry.nav_group_order;
		}

		if (!entry.nav_section_key) {
			group.items.push(entry);
			continue;
		}

		const section_id = `${module_key}:${entry.nav_section_key}`;
		const existing_order = section_orders.get(section_id);
		if (existing_order !== undefined && existing_order !== entry.nav_section_order && existing_order !== null && entry.nav_section_order !== null) {
			throw new Error(`build_nav_groups: conflicting nav_section_order values for "${section_id}"`);
		}
		if (!section_orders.has(section_id) || existing_order === null) section_orders.set(section_id, entry.nav_section_order ?? null);

		let section = group.sections.find((candidate) => candidate.key === entry.nav_section_key);
		if (!section) {
			section = { key: entry.nav_section_key, title_key: entry.nav_section_key, items: [], order: entry.nav_section_order ?? null };
			group.sections.push(section);
		} else if (section.order === null && entry.nav_section_order !== null && entry.nav_section_order !== undefined) {
			section.order = entry.nav_section_order;
		}
		section.items.push(entry);
	}

	const by_item_order = (a: NavRoute, b: NavRoute) => (a.nav_item_order ?? Infinity) - (b.nav_item_order ?? Infinity);
	for (const group of groups.values()) {
		group.items.sort(by_item_order);
		for (const section of group.sections) section.items.sort(by_item_order);
		group.sections.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
	}

	return [...groups.entries()].sort(([a_key, a], [b_key, b]) => {
		if (a.order !== null || b.order !== null) return (a.order ?? Infinity) - (b.order ?? Infinity);
		if (a_key === "") return -1;
		if (b_key === "") return 1;
		return a_key.localeCompare(b_key);
	}).map(([, group]) => group);
}
