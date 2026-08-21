import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { sidebar_props } from "../lib/sidebar";
import { accept_visual_page, clear_visual_reports, delete_visual_report, find_visual_run, list_visual_runs, promote_page_recording, start_page_evidence_run, start_page_recording_run, visual_asset_file } from "../lib/visual_store";
import { present_visual_run } from "../lib/visual_view";

export async function get_reports_page(req: BunRequest): Promise<Response> {
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 308);
}

export async function get_report_page(req: BunRequest): Promise<Response> {
	const run_id = req.params.id;
	if (!run_id) return new Response("Report id is required.", { status: 400 });
	const run = await find_visual_run(run_id);
	const ctx = await create_ctx(req, import.meta.dir);
	const report_label = ctx.translations.breadcrumbs.results;
	if (!run || run.operation !== "compare") {
		const breadcrumb_items = [{ label: report_label, href: "/run-tests" }, { label: ctx.translations.breadcrumbs.report }];
		return render("detail", { data: { breadcrumb_items, report: null, busy: false, form_error: "Comparison report not found.", ...(await sidebar_props(ctx.request_url)) }, ctx, status: 404 });
	}
	const breadcrumb_items = [{ label: report_label, href: "/run-tests" }, { label: run.project_name }];
	return render("detail", { data: { breadcrumb_items, report: present_visual_run(run), busy: false, form_error: "", ...(await sidebar_props(ctx.request_url)) }, ctx });
}

export async function get_report_asset(req: BunRequest): Promise<Response> {
	const url = new URL(req.url);
	const path = url.searchParams.get("path");
	if (!path) return new Response("Artifact path is required.", { status: 400 });
	try {
		const file = visual_asset_file(path);
		const exists = await file.exists();
		if (!exists) return new Response("Artifact not found.", { status: 404 });
		return new Response(file);
	} catch {
		return new Response("Artifact not found.", { status: 404 });
	}
}

export async function post_accept_report_page(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const accept_key = params.get("accept_key");
	if (!accept_key) return new Response("Acceptance key is required.", { status: 400 });
	const key_parts = accept_key.split("|");
	if (key_parts.length !== 2) return new Response("Acceptance key is invalid.", { status: 400 });
	const run_id = key_parts[0]!;
	const page_id = key_parts[1]!;
	try {
		await accept_visual_page(run_id, page_id);
		const locale = resolve_locale(req);
		const target = localized_url(`/results/visual/${run_id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const run = await find_visual_run(run_id);
		const ctx = await create_ctx(req, import.meta.dir);
		const report_label = ctx.translations.breadcrumbs.results;
		const current_label = run?.project_name ?? ctx.translations.breadcrumbs.report;
		const breadcrumb_items = [{ label: report_label, href: "/run-tests" }, { label: current_label }];
		return render("detail", {
			data: { breadcrumb_items, report: run ? present_visual_run(run) : null, busy: false, form_error: message, ...(await sidebar_props(ctx.request_url)) },
			ctx,
			status: 409,
		});
	}
}

export async function post_record_evidence(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const evidence_key = params.get("evidence_key");
	if (!evidence_key) return new Response("Evidence key is required.", { status: 400 });
	const key_parts = evidence_key.split("|");
	if (key_parts.length !== 2) return new Response("Evidence key is invalid.", { status: 400 });
	const run_id = key_parts[0]!;
	const page_id = key_parts[1]!;
	try {
		await start_page_evidence_run(run_id, page_id);
		const locale = resolve_locale(req);
		const target = localized_url(`/results/visual/${run_id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const run = await find_visual_run(run_id);
		const ctx = await create_ctx(req, import.meta.dir);
		const report_label = ctx.translations.breadcrumbs.results;
		const current_label = run?.project_name ?? ctx.translations.breadcrumbs.report;
		const breadcrumb_items = [{ label: report_label, href: "/run-tests" }, { label: current_label }];
		return render("detail", {
			data: { breadcrumb_items, report: run ? present_visual_run(run) : null, busy: false, form_error: message, ...(await sidebar_props(ctx.request_url)) },
			ctx,
			status: 409,
		});
	}
}

export async function post_record_recording(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const recording_key = params.get("recording_key");
	if (!recording_key) return new Response("Recording key is required.", { status: 400 });
	const key_parts = recording_key.split("|");
	if (key_parts.length !== 2) return new Response("Recording key is invalid.", { status: 400 });
	const run_id = key_parts[0]!;
	const page_id = key_parts[1]!;
	try {
		await start_page_recording_run(run_id, page_id);
		const locale = resolve_locale(req);
		const target = localized_url(`/results/visual/${run_id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const run = await find_visual_run(run_id);
		const ctx = await create_ctx(req, import.meta.dir);
		const report_label = ctx.translations.breadcrumbs.results;
		const current_label = run?.project_name ?? ctx.translations.breadcrumbs.report;
		const breadcrumb_items = [{ label: report_label, href: "/run-tests" }, { label: current_label }];
		return render("detail", {
			data: { breadcrumb_items, report: run ? present_visual_run(run) : null, busy: false, form_error: message, ...(await sidebar_props(ctx.request_url)) },
			ctx,
			status: 409,
		});
	}
}

export async function post_promote_recording(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const promote_key = params.get("promote_key");
	const filename = params.get("filename") ?? "";
	if (!promote_key) return new Response("Promote key is required.", { status: 400 });
	const key_parts = promote_key.split("|");
	if (key_parts.length !== 2) return new Response("Promote key is invalid.", { status: 400 });
	const run_id = key_parts[0]!;
	const page_id = key_parts[1]!;
	try {
		await promote_page_recording(run_id, page_id, filename);
		const locale = resolve_locale(req);
		const target = localized_url(`/results/visual/${run_id}`, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const run = await find_visual_run(run_id);
		const ctx = await create_ctx(req, import.meta.dir);
		const report_label = ctx.translations.breadcrumbs.results;
		const current_label = run?.project_name ?? ctx.translations.breadcrumbs.report;
		const breadcrumb_items = [{ label: report_label, href: "/run-tests" }, { label: current_label }];
		return render("detail", {
			data: { breadcrumb_items, report: run ? present_visual_run(run) : null, busy: false, form_error: message, ...(await sidebar_props(ctx.request_url)) },
			ctx,
			status: 409,
		});
	}
}

export async function post_delete_report(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const run_id = params.get("run_id");
	if (!run_id) return new Response("Report id is required.", { status: 400 });
	try {
		await delete_visual_report(run_id);
		const locale = resolve_locale(req);
		const target = localized_url("/run-tests", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const ctx = await create_ctx(req, import.meta.dir);
		const runs = await list_visual_runs();
		const compare_runs = runs.filter((run) => run.operation === "compare");
		const reports = compare_runs.map(present_visual_run);
		return render("index", { data: { reports, busy: false, form_error: message, ...(await sidebar_props(ctx.request_url)) }, ctx, status: 409 });
	}
}

export async function post_clear_reports(req: BunRequest): Promise<Response> {
	await clear_visual_reports();
	const locale = resolve_locale(req);
	const target = localized_url("/run-tests", locale);
	return Response.redirect(target, 303);
}

export const reports_crud = {
	"/reports": { GET: get_reports_page },
	"/reports/asset": { GET: get_report_asset },
	"/reports/accept": { POST: post_accept_report_page },
	"/reports/record-evidence": { POST: post_record_evidence },
	"/reports/record-recording": { POST: post_record_recording },
	"/reports/promote-recording": { POST: post_promote_recording },
	"/reports/delete": { POST: post_delete_report },
	"/reports/clear": { POST: post_clear_reports },
	"/reports/:id": { GET: get_report_page },
	"/results/visual/:id": { GET: get_report_page },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/reports",
		crud: reports_crud,
		nav_title_key: "reeqa.reports",
		module: "system",
		nav_module: null,
		is_menu_entry: false,
	},
];
