import { navigation } from "./config";
import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { sidebar_props } from "../lib/sidebar";
import { cancel_visual_run, find_visual_run } from "../lib/visual_store";
import { present_visual_run } from "../lib/visual_view";

export async function get_visual_run_page(req: BunRequest): Promise<Response> {
	const run_id = req.params.id;
	if (!run_id) return new Response("Visual run id is required.", { status: 400 });
	const run = await find_visual_run(run_id);
	const ctx = await create_ctx(req, import.meta.dir);
	if (!run) {
		const breadcrumb_items = [{ label: ctx.translations.breadcrumbs.run_tests, href: "/run-tests" }, { label: ctx.translations.breadcrumbs.visual_run }];
		return render("index", { data: { breadcrumb_items, run: null, busy: false, form_error: "Visual run not found.", ...(await sidebar_props(ctx.request_url)) }, ctx, status: 404 });
	}
	const busy = run.status === "queued" || run.status === "running" || run.status === "canceling";
	const run_view = present_visual_run(run);
	const parent_item = { label: ctx.translations.breadcrumbs.run_tests, href: "/run-tests" };
	const breadcrumb_items = [parent_item, { label: run_view.operation_label }];
	return render("index", { data: { breadcrumb_items, run: run_view, busy, form_error: "", ...(await sidebar_props(ctx.request_url)) }, ctx });
}

export async function post_cancel_visual_run(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const run_id = params.get("run_id");
	if (!run_id) return new Response("Visual run id is required.", { status: 400 });
	try {
		await cancel_visual_run(run_id);
		const locale = resolve_locale(req);
		const target = localized_url(`/visual-runs/${run_id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const run = await find_visual_run(run_id);
		const ctx = await create_ctx(req, import.meta.dir);
		const run_view = run ? present_visual_run(run) : null;
		const current_label = run_view?.operation_label ?? ctx.translations.breadcrumbs.visual_run;
		const parent_item = { label: ctx.translations.breadcrumbs.run_tests, href: "/run-tests" };
		const breadcrumb_items = [parent_item, { label: current_label }];
		return render("index", {
			data: { breadcrumb_items, run: run_view, busy: false, form_error: message, ...(await sidebar_props(ctx.request_url)) },
			ctx,
			status: 409,
		});
	}
}

export const visual_runs_crud = {
	"/visual-runs/cancel": { POST: post_cancel_visual_run },
	"/visual-runs/:id": { GET: get_visual_run_page },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/visual-runs",
		crud: visual_runs_crud,
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_item_order: navigation.item_order,
		nav_section_order: navigation.section_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
		is_menu_entry: false,
	},
];
