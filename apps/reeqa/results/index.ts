import { navigation } from "./config";
import { localized_url, resolve_locale } from "$lib/route";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { get_active_project } from "../lib/project_store";
import { clear_completed_runs } from "../lib/run_store";
import { clear_visual_reports } from "../lib/visual_store";

export function get_results_redirect(req: BunRequest): Response {
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 308);
}

export async function post_clear_result_history(req: BunRequest): Promise<Response> {
	const active_project = await get_active_project();
	await clear_completed_runs(active_project?.id);
	await clear_visual_reports(active_project?.id);
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 303);
}

export const results_crud = {
	"/results": { GET: get_results_redirect },
	"/results/clear": { POST: post_clear_result_history },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/results",
		crud: results_crud,
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_item_order: navigation.item_order,
		nav_section_order: navigation.section_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
