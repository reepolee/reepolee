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

export type NavGroup = { label: string; items: NavRoute[]; };

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

export function get_nav_routes(): NavRoute[] { return state().nav_routes; }

export function set_nav_routes(nav: NavRoute[]): void { state().nav_routes = nav; }

export function get_nav_groups(): NavGroup[] { return state().nav_groups; }

export function set_nav_groups(groups: NavGroup[]): void { state().nav_groups = groups; }

export function get_base_data(): Record<string, any> { return state().base_data; }

export function set_base_data(data: Record<string, any>): void { state().base_data = data; }

export function get_version(): number { return state().version; }

// @internal - for testing only
export function get_state(): RouteState { return state(); }

/**
 * Reset all route state to defaults.
 * Useful for testing - ensures a clean slate.
 */
export function reset_state(): void { globalThis.__reepolee_route_state = default_state(); }

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

	const grouped: Record<string, NavGroup> = {};
	for (const entry of menu_entries) {
		const module_key = entry.module ?? "";
		if (!grouped[module_key]) {
			const label = entry.module ? entry.module.toLowerCase() : "";
			grouped[module_key] = { label, items: [] };
		}
		grouped[module_key].items.push(entry);
	}

	return Object.entries(grouped).sort(([a], [b]) => {
		if (a === "") return -1;
		if (b === "") return 1;
		return a.localeCompare(b);
	}).map(([, group]) => group);
}
