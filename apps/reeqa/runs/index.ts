import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { cancel_run, clear_completed_runs, find_run, find_running_run } from "../lib/run_store";
import { sidebar_props } from "../lib/sidebar";
import { present_run } from "../lib/view";

export async function get_runs_page(req: BunRequest): Promise<Response> {
	const locale = resolve_locale(req);
	const target = localized_url("/command-checks", locale);
	return Response.redirect(target, 308);
}

export async function get_run_page(req: BunRequest): Promise<Response> {
	const run_id = req.params.id;
	if (!run_id) return new Response("QA run id is required.", { status: 400 });
	const run = await find_run(run_id);
	const active_run = await find_running_run();
	const ctx = await create_ctx(req, import.meta.dir);
	const runs_label = ctx.translations.breadcrumbs.results;
	if (!run) {
		const breadcrumb_items = [{ label: runs_label, href: "/command-checks" }, { label: ctx.translations.breadcrumbs.run }];
		return render("detail", {
			data: { breadcrumb_items, run: null, busy: Boolean(active_run), form_error: "QA run not found.", ...(await sidebar_props(ctx.request_url)) },
			ctx,
			status: 404,
		});
	}

	const breadcrumb_items = [{ label: runs_label, href: "/command-checks" }, { label: run.suite_name }];
	return render("detail", {
		data: { breadcrumb_items, run: present_run(run), busy: run.status === "running" || run.status === "canceling", form_error: "", ...(await sidebar_props(ctx.request_url)) },
		ctx,
	});
}

export async function post_cancel_run(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const run_id = params.get("run_id");
	if (!run_id) return new Response("QA run id is required.", { status: 400 });
	const locale = resolve_locale(req);
	try {
		await cancel_run(run_id);
		const target = localized_url(`/results/run/${run_id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const run = await find_run(run_id);
		const ctx = await create_ctx(req, import.meta.dir);
		const current_label = run?.suite_name ?? ctx.translations.breadcrumbs.run;
		const breadcrumb_items = [{ label: ctx.translations.breadcrumbs.results, href: "/command-checks" }, { label: current_label }];
		return render("detail", {
			data: { breadcrumb_items, run: run ? present_run(run) : null, busy: false, form_error: message, ...(await sidebar_props(ctx.request_url)) },
			ctx,
			status: 409,
		});
	}
}

export async function post_clear_runs(req: BunRequest): Promise<Response> {
	await clear_completed_runs();
	const locale = resolve_locale(req);
	const target = localized_url("/command-checks", locale);
	return Response.redirect(target, 303);
}

export const runs_crud = {
	"/runs": { GET: get_runs_page },
	"/runs/:id": { GET: get_run_page },
	"/runs/cancel": { POST: post_cancel_run },
	"/runs/clear": { POST: post_clear_runs },
	"/results/run/:id": { GET: get_run_page },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/runs",
		crud: runs_crud,
		nav_title_key: "reeqa.runs",
		module: "system",
		nav_module: null,
		is_menu_entry: false,
	},
];
