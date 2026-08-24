import { localized_url, resolve_locale } from "$lib/route";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { post_capture_baseline, post_compare_to_baseline } from "../run_qa";

export function get_baselines_redirect(req: BunRequest): Response {
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 308);
}

export function get_legacy_controls_redirect(req: BunRequest): Response {
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 308);
}

export const baselines_crud = {
	"/baselines": { GET: get_baselines_redirect },
	"/baselines/capture": { POST: post_capture_baseline },
	"/controls": { GET: get_legacy_controls_redirect },
	"/controls/generate": { POST: post_capture_baseline },
	"/controls/compare": { POST: post_compare_to_baseline },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/baselines",
		crud: baselines_crud,
		module: "system",
		nav_module: null,
	},
];
