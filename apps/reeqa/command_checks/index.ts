import { navigation } from "./config";
import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { get_active_page_set } from "../lib/page_set_store";
import { get_active_project, list_projects, require_active_project, suites_for_project } from "../lib/project_store";
import { clear_completed_runs, find_running_run, list_runs, start_run } from "../lib/run_store";
import { sidebar_props } from "../lib/sidebar";
import { present_run } from "../lib/view";

async function render_command_checks_page(req: BunRequest, form_error = "", status = 200): Promise<Response> {
	const projects = await list_projects();
	const active_project = await get_active_project();
	const active_page_set = active_project ? await get_active_page_set(active_project.id) : undefined;
	const suites = active_project ? await suites_for_project(active_project) : [];
	const runs = (await list_runs()).filter((run) => active_project === undefined || run.project_id === active_project.id);
	const active_run = await find_running_run();
	const run_views = runs.map(present_run);
	const ctx = await create_ctx(req, import.meta.dir);
	return render("index", {
		data: {
			projects,
			project: active_project,
			active_page_set,
			suites,
			runs: run_views,
			active_run,
			busy: Boolean(active_run),
			form_error,
			...(await sidebar_props(ctx.request_url)),
		},
		ctx,
		status,
	});
}

export async function get_command_checks_page(req: BunRequest): Promise<Response> {
	return render_command_checks_page(req);
}

export async function post_start_suite(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const suite_code_value = params.get("suite_code");
	if (!suite_code_value) return render_command_checks_page(req, "Select a QA suite.", 400);
	const suite_code = suite_code_value.trim();
	if (!suite_code) return render_command_checks_page(req, "Select a QA suite.", 400);

	try {
		const project = await require_active_project();
		const run = await start_run(project.id, suite_code);
		const locale = resolve_locale(req);
		const target = localized_url(`/results/run/${run.id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_command_checks_page(req, message, 409);
	}
}

export async function post_clear_runs(req: BunRequest): Promise<Response> {
	const active_project = await get_active_project();
	await clear_completed_runs(active_project?.id);
	const locale = resolve_locale(req);
	const target = localized_url("/command-checks", locale);
	return Response.redirect(target, 303);
}

export const command_checks_crud = {
	"/command-checks": { GET: get_command_checks_page },
	"/command-checks/suite": { POST: post_start_suite },
	"/command-checks/clear": { POST: post_clear_runs },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/command-checks",
		crud: command_checks_crud,
		nav_title_key: "reeqa.command_checks",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_item_order: navigation.item_order,
		nav_section_order: navigation.section_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
