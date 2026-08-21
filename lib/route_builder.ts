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
	/** Draw a horizontal rule under this nav entry in the sidebar (e.g. to group sections). */
	nav_rule_after?: boolean;
};

export function build_nav_routes(defs: RouteDefinition[]): NavRoute[] {
	return defs.filter((d) => d.nav_title_key && d.is_menu_entry !== false).map((d) => ({
		url: d.url,
		nav_title_key: d.nav_title_key!,
		module: d.nav_module !== undefined ? d.nav_module : (d.module ?? null),
		// Auth module always gates visibility, even when nav_module moves the
		// entry to a flat root position.
		required_module: d.module ?? null,
		is_menu_entry: true,
		...(d.nav_rule_after === true ? { nav_rule_after: true } : {}),
	}));
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
