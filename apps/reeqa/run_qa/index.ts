import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { iso_datetime } from "../lib/format";
import { find_page_set, get_active_page_set, page_set_capture_size, page_set_page_count, require_active_page_set } from "../lib/page_set_store";
import { find_project, get_active_project, list_projects, require_active_project } from "../lib/project_store";
import { find_running_run } from "../lib/run_store";
import { add_schedule, list_schedules, remove_schedule } from "../lib/schedule";
import { sidebar_props } from "../lib/sidebar";
import { clear_visual_reports, find_active_visual_run, get_baseline_summary, list_visual_runs, start_visual_run, visual_capabilities, type Visual_operation } from "../lib/visual_store";
import { present_visual_run } from "../lib/visual_view";

async function render_run_qa_page(req: BunRequest, form_error = "", status = 200): Promise<Response> {
	const projects = await list_projects();
	const active_project = await get_active_project();
	const active_page_set = active_project ? await get_active_page_set(active_project.id) : undefined;
	const baseline = active_project && active_page_set ? await get_baseline_summary(active_project.id, active_page_set.id) : undefined;
	const project_view = active_project ? {
		...active_project,
		page_set: active_page_set,
		capture_size_label: active_page_set ? `${page_set_capture_size(active_page_set).width}×${page_set_capture_size(active_page_set).height}` : "",
		baseline_ready: baseline !== undefined && !baseline.db_snapshot_missing,
		baseline: baseline ? {
			...baseline,
			captured_display: iso_datetime(baseline.captured_at),
			latest_capture_count: baseline.latest_capture_urls.length,
			retained_count: baseline.retained_urls.length,
		} : undefined,
	} : null;
	const visual_runs = (await list_visual_runs()).filter((run) => (active_project === undefined || run.project_id === active_project.id) && (active_page_set === undefined || run.page_set_id === active_page_set.id));
	const comparison_views = visual_runs.filter((run) => run.operation === "compare").map(present_visual_run);
	const active_run = await find_running_run();
	const active_visual_run = await find_active_visual_run();
	const capabilities = visual_capabilities();
	const schedules = await Promise.all((await list_schedules()).map(async (schedule) => {
		const schedule_project = await find_project(schedule.project_id);
		const schedule_page_set = await find_page_set(schedule.page_set_id);
		return {
			...schedule,
			project_name: schedule_project?.name ?? schedule.project_id,
			page_set_name: schedule_page_set?.name ?? schedule.page_set_id,
			last_run_display: schedule.last_run_at === undefined ? "" : iso_datetime(schedule.last_run_at),
		};
	}));
	const ctx = await create_ctx(req, import.meta.dir);
	return render("index", {
		data: {
			projects,
			project: project_view,
			active_page_set: active_page_set ? { ...active_page_set, page_count: page_set_page_count(active_page_set) } : undefined,
			results: comparison_views,
			active_run,
			active_visual_run,
			capabilities,
			schedules,
			busy: Boolean(active_run || active_visual_run),
			form_error,
			...(await sidebar_props(ctx.request_url)),
		},
		ctx,
		status,
	});
}

export async function get_run_qa_page(req: BunRequest): Promise<Response> {
	return render_run_qa_page(req);
}

export function get_legacy_run_qa_redirect(req: BunRequest): Response {
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 308);
}

async function post_start_visual_operation(req: BunRequest, operation: Visual_operation): Promise<Response> {
	try {
		const project = await require_active_project();
		const page_set = await require_active_page_set(project.id);
		const run = await start_visual_run(project.id, operation, page_set.id);
		const locale = resolve_locale(req);
		const target = localized_url(`/visual-runs/${run.id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_run_qa_page(req, message, 409);
	}
}

export async function post_capture_baseline(req: BunRequest): Promise<Response> {
	return post_start_visual_operation(req, "baseline");
}

export async function post_compare_to_baseline(req: BunRequest): Promise<Response> {
	return post_start_visual_operation(req, "compare");
}

export async function post_clear_visual_reports(req: BunRequest): Promise<Response> {
	const active_project = await get_active_project();
	const active_page_set = active_project ? await get_active_page_set(active_project.id) : undefined;
	await clear_visual_reports(active_project?.id, active_page_set?.id);
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 303);
}

export async function post_add_schedule(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const operation_value = params.get("operation");
	const interval_value = params.get("interval_hours");
	try {
		const project = await require_active_project();
		const page_set = await require_active_page_set(project.id);
		const operation: Visual_operation = operation_value === "baseline" ? "baseline" : "compare";
		const interval_hours = Number(interval_value);
		await add_schedule(project.id, page_set.id, operation, interval_hours);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_run_qa_page(req, message, 409);
	}
	const locale = resolve_locale(req);
	return Response.redirect(localized_url("/run-tests", locale), 303);
}

export async function post_remove_schedule(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const schedule_id = params.get("schedule_id");
	try {
		if (!schedule_id) throw new Error("Schedule id is required.");
		await remove_schedule(schedule_id);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_run_qa_page(req, message, 409);
	}
	const locale = resolve_locale(req);
	return Response.redirect(localized_url("/run-tests", locale), 303);
}

export const run_qa_crud = {
	"/run-qa": { GET: get_legacy_run_qa_redirect },
	"/run-qa/compare": { POST: post_compare_to_baseline },
	"/run-tests": { GET: get_run_qa_page },
	"/run-tests/compare": { POST: post_compare_to_baseline },
	"/run-tests/capture": { POST: post_capture_baseline },
	"/run-tests/clear": { POST: post_clear_visual_reports },
	"/run-tests/schedule": { POST: post_add_schedule },
	"/run-tests/schedule/remove": { POST: post_remove_schedule },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/run-tests",
		crud: run_qa_crud,
		nav_title_key: "reeqa.run_qa",
		module: "system",
		nav_module: null,
	},
];
