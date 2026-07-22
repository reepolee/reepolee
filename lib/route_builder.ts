import { mount_prefix, require_module_mw } from "$lib/middleware";
import type { Handler, RouteTable } from "$lib/middleware/types";

export type RouteDefinition = {
	url: string;
	handler?: Handler;
	methods?: Record<string, Handler>;
	resource?: RouteTable;
	crud?: RouteTable;
	nav_title_key?: string;
	module?: string | null;
	is_menu_entry?: boolean;
};

export type NavRoute = { url: string; nav_title_key: string; module: string | null; is_menu_entry: boolean; };

export function build_nav_routes(defs: RouteDefinition[]): NavRoute[] {
	return defs.filter((d) => d.nav_title_key && d.is_menu_entry !== false).map((d) => ({
		url: d.url,
		nav_title_key: d.nav_title_key!,
		module: d.module ?? null,
		is_menu_entry: true,
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
				const mws = d.module ? [require_module_mw(d.module)] : [];
				return mount_prefix(pfx, d.crud, ...mws);
			}
			return {};
		})
	);
}
