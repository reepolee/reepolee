import { mount_prefix, require_module_mw } from "$lib/middleware";
import type { Handler, RouteTable } from "$lib/middleware/types";
import { publisher_signal_mw } from "$lib/publisher_signal";

export type RouteDefinition = {
	url: string;
	handler?: Handler;
	methods?: Record<string, Handler>;
	resource?: RouteTable;
	crud?: RouteTable;
	nav_title_key?: string;
	/** Module required to access the route (gates handlers via require_module_mw). */
	module?: string | null;
	/**
	 * Module the nav entry is grouped under. Defaults to `module`. Set to `null`
	 * to keep a route at the root of the nav (flat entry, no group) while its
	 * authorization still uses `module` - e.g. the reeman app pages,
	 * which require the "system" module but are served at root URLs.
	 */
	nav_module?: string | null;
	/** Optional translated second-level navigation section. */
	nav_section_key?: string | null;
	/** Optional presentation order within a section or outer group. */
	nav_item_order?: number | null;
	/** Optional presentation order for the named section. */
	nav_section_order?: number | null;
	/** Optional presentation order for the outer navigation group. */
	nav_group_order?: number | null;
	/** Optional presentation order for a final sidebar link. */
	nav_final_order?: number | null;
	is_menu_entry?: boolean;
	/** Draw a horizontal rule under this nav entry in the sidebar (e.g. to group sections). */
	nav_rule_after?: boolean;
};

export type NavRoute = {
	url: string;
	nav_title_key: string;
	/** Nav grouping key (group label). `null` renders a flat root entry. */
	module: string | null;
	/**
	 * Module the user must have to see this entry. Gates flat entries
	 * (`nav_module: null`) in the layout, which group by `module` and so carry
	 * no group label to check. Equals `module` unless nav_module is set.
	 */
	required_module: string | null;
	is_menu_entry: boolean;
	nav_section_key?: string | null;
	nav_item_order?: number | null;
	nav_section_order?: number | null;
	nav_group_order?: number | null;
	nav_final_order?: number | null;
	/** Draw a horizontal rule under this nav entry in the sidebar (e.g. to group sections). */
	nav_rule_after?: boolean;
};

export type NavLink = {
	key: string;
	url: string;
	nav_title_key: string;
	nav_final_order: number;
	requires_user: boolean;
};

export const nav_final_links: NavLink[] = [
	{ key: "profile", url: "/profile", nav_title_key: "nav_auth.profile", nav_final_order: 10, requires_user: true },
	{ key: "login", url: "/login", nav_title_key: "nav_auth.login", nav_final_order: 20, requires_user: false },
];

function valid_order(value: unknown, field_name: string, url: string): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`build_nav_routes: ${field_name} for "${url}" must be a finite number`);
	}
	return value;
}

function valid_section_key(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const section_key = value.trim();
	return section_key.length > 0 && section_key.length <= 100 ? section_key : null;
}

export function build_nav_routes(defs: RouteDefinition[]): NavRoute[] {
	return defs.filter((d) => d.nav_title_key && d.is_menu_entry !== false).map((d) => {
		const nav_section_key = valid_section_key(d.nav_section_key);
		return {
			url: d.url,
			nav_title_key: d.nav_title_key!,
			module: d.nav_module !== undefined ? d.nav_module : (d.module ?? null),
			// Auth module always gates visibility, even when nav_module moves the
			// entry to a flat root position.
			required_module: d.module ?? null,
			is_menu_entry: true,
			...(nav_section_key ? { nav_section_key } : {}),
			...(d.nav_item_order !== undefined ? { nav_item_order: valid_order(d.nav_item_order, "nav_item_order", d.url) } : {}),
			...(d.nav_section_order !== undefined ? { nav_section_order: valid_order(d.nav_section_order, "nav_section_order", d.url) } : {}),
			...(d.nav_group_order !== undefined ? { nav_group_order: valid_order(d.nav_group_order, "nav_group_order", d.url) } : {}),
			...(d.nav_final_order !== undefined ? { nav_final_order: valid_order(d.nav_final_order, "nav_final_order", d.url) } : {}),
			...(d.nav_rule_after === true ? { nav_rule_after: true } : {}),
		};
	});
}

export function build_routes(defs: RouteDefinition[]) {
	return Object.assign(
		{},
		...defs.map((d) => {
			if (d.handler) return { [d.url]: d.handler };
			if (d.methods) return { [d.url]: d.methods };
			if (d.resource) return d.resource;
			if (d.crud) {
				const segments = d.url.split("/").filter(Boolean).slice(0, -1);
				const pfx = segments.length > 0 ? `/${segments.join("/")}` : "";
				// Guard: extracted prefix must be "" or start with "/" and not end with "/"
				if (pfx !== "" && !pfx.startsWith("/")) { throw new Error(`build_routes: extracted prefix "${pfx}" must start with "/"`); }
				if (pfx.length > 1 && pfx.endsWith("/")) { throw new Error(`build_routes: extracted prefix "${pfx}" must not end with "/"`); }
				if (pfx === "/") {
					throw new Error(
						`build_routes: extracted prefix is "/" - CRUD mount would produce "//path"`,
					);
				}
				const mws = d.module
					? [require_module_mw(d.module), publisher_signal_mw()]
					: [publisher_signal_mw()];
				return mount_prefix(pfx, d.crud, ...mws);
			}
			return {};
		})
	);
}
