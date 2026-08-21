import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { get_active_page_set, page_set_page_count } from "../lib/page_set_store";
import { get_active_project, list_projects, suites_for_project } from "../lib/project_store";
import { find_running_run, list_runs } from "../lib/run_store";
import { sidebar_props } from "../lib/sidebar";
import { find_active_visual_run, get_baseline_summary, list_visual_runs } from "../lib/visual_store";
import { present_run } from "../lib/view";

export async function get_dashboard_page(req: BunRequest): Promise<Response> {
	const runs = await list_runs();
	const projects = await list_projects();
	const visual_runs = await list_visual_runs();
	const active_project = await get_active_project();
	const active_page_set = active_project ? await get_active_page_set(active_project.id) : undefined;
	const project_runs = active_project ? runs.filter((run) => run.project_id === active_project.id) : [];
	const project_visual_runs = active_project ? visual_runs.filter((run) => run.project_id === active_project.id) : [];
	const baseline_ready = active_project && active_page_set ? Boolean(await get_baseline_summary(active_project.id, active_page_set.id)) : false;
	const active_suites = active_project ? await suites_for_project(active_project) : [];
	const available_suites = active_suites.filter((suite) => suite.available);
	const active_run = await find_running_run();
	const active_visual_run = await find_active_visual_run();
	const passed_count = project_runs.filter((run) => run.status === "passed").length;
	const failed_count = project_runs.filter((run) => run.status === "failed").length;
	const recent_run_records = project_runs.slice(0, 5);
	const recent_runs = recent_run_records.map(present_run);
	const active_run_view = active_run ? present_run(active_run) : null;
	const ctx = await create_ctx(req, import.meta.dir);

	return render("index", {
		data: {
			active_project,
			active_page_set: active_page_set ? { ...active_page_set, page_count: page_set_page_count(active_page_set) } : undefined,
			baseline_ready,
			suites: available_suites,
			projects,
			result_count: project_runs.length + project_visual_runs.filter((run) => run.operation === "compare").length,
			recent_runs,
			active_run: active_run_view,
			busy: Boolean(active_run || active_visual_run),
			passed_count,
			failed_count,
			...(await sidebar_props(ctx.request_url)),
		},
		ctx,
	});
}

export async function get_busy_status(): Promise<Response> {
	const active_run = await find_running_run();
	const active_visual_run = await find_active_visual_run();
	return Response.json({ busy: Boolean(active_run || active_visual_run) });
}

export const dashboard_crud = {
	"/": { GET: get_dashboard_page },
	"/__busy": { GET: get_busy_status },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/",
		crud: dashboard_crud,
		nav_title_key: "reeqa.dashboard",
		module: "system",
		nav_module: null,
	},
];
