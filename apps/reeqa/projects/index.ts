import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { visual_capture_presets, resolve_capture_preset } from "../lib/config";
import { iso_datetime } from "../lib/format";
import { clear_active_page_set_selection, create_page_set, delete_page_set, find_page_set, get_active_page_set, is_workflow_page_set, list_page_sets, page_set_capture_size, page_set_page_count, require_page_set, set_active_page_set_id, update_page_set, type Page_set_input } from "../lib/page_set_store";
import { create_project, delete_project, duplicate_project, get_active_project, list_projects, require_active_project, set_active_project_id, update_project, type Qa_project } from "../lib/project_store";
import { sidebar_props } from "../lib/sidebar";
import { get_baseline_summary, sitemap_pages_for_project, type Sitemap_page } from "../lib/visual_store";
import { parse_workflow_steps } from "../lib/workflow";

type Project_form = {
	name: string;
	path: string;
	base_url: string;
};

type Page_set_form = {
	name: string;
	kind: "urls" | "workflow";
	urls: string[];
	steps_text: string;
	capture_preset: string;
	auto_evidence: boolean;
	auto_recording: boolean;
};

function capture_preset_for(size: { width: number; height: number; }): { id: string; label: string; } {
	const preset = visual_capture_presets.find((candidate) => candidate.width === size.width && candidate.height === size.height);
	return preset ? { id: preset.id, label: preset.label } : { id: "desktop", label: "Desktop" };
}

async function sitemap_pages_or_error(project: Qa_project): Promise<{ pages: Sitemap_page[]; error: string; }> {
	try {
		return { pages: await sitemap_pages_for_project(project), error: "" };
	} catch (error) {
		return { pages: [], error: error instanceof Error ? error.message : String(error) };
	}
}

function format_lastmod(lastmod: string | undefined): string {
	if (!lastmod) return "";
	// Sitemap lastmod is already ISO 8601 - slice it to a display value.
	return iso_datetime(lastmod);
}

function edited_today(lastmod: string | undefined): boolean {
	if (!lastmod) return false;
	const date = new Date(lastmod);
	if (Number.isNaN(date.getTime())) return false;
	const now = new Date();
	return date.getFullYear() === now.getFullYear()
		&& date.getMonth() === now.getMonth()
		&& date.getDate() === now.getDate();
}

async function validate_sitemap_urls(project: Qa_project, selected_urls: string[]): Promise<void> {
	const sitemap_pages = await sitemap_pages_for_project(project);
	if (selected_urls.length === 0) throw new Error("Select at least one sitemap page.");
	const sitemap_set = new Set(sitemap_pages.map((page) => page.url));
	const invalid_url = selected_urls.find((url) => !sitemap_set.has(url));
	if (invalid_url) throw new Error(`Page is not in the current sitemap: ${invalid_url}`);
}

type Render_opts = {
	project_form?: Project_form;
	project_form_error?: string;
	project_edit_form?: Project_form;
	project_edit_form_error?: string;
	page_error?: string;
	page_set_form_error?: string;
	page_set_error_id?: string;
	status?: number;
	page_set_create_form?: Page_set_form;
	page_set_edit_form?: Page_set_form & { page_set_id: string };
	open_create_dialog?: boolean;
};

async function render_projects_page(req: BunRequest, opts: Render_opts = {}): Promise<Response> {
	const {
		project_form = { name: "", path: "", base_url: "" },
		project_form_error = "",
		project_edit_form: requested_edit_form,
		project_edit_form_error = "",
		page_error = "",
		page_set_form_error = "",
		page_set_error_id = "",
		status = 200,
		page_set_create_form = { name: "", kind: "urls", urls: [], steps_text: "", capture_preset: "desktop", auto_evidence: false, auto_recording: false },
		page_set_edit_form,
		open_create_dialog = false,
	} = opts;
	const projects = await list_projects();
	const active_project = await get_active_project();
	const project_edit_form = requested_edit_form ?? (active_project
		? { name: active_project.name, path: active_project.path, base_url: active_project.base_url }
		: { name: "", path: "", base_url: "" });
	const sitemap = active_project ? await sitemap_pages_or_error(active_project) : { pages: [] as Sitemap_page[], error: "" };
	const page_sets = active_project ? await list_page_sets(active_project.id) : [];
	const active_page_set = active_project ? await get_active_page_set(active_project.id) : undefined;
	const sitemap_url_set = new Set(sitemap.pages.map((page) => page.url));
	const sitemap_page_views = sitemap.pages.map((page) => ({
		url: page.url,
		lastmod: page.lastmod,
		lastmod_display: format_lastmod(page.lastmod),
		is_new: edited_today(page.lastmod),
	}));
	const page_set_views = await Promise.all(page_sets.map(async (page_set) => {
		const baseline = active_project ? await get_baseline_summary(active_project.id, page_set.id) : undefined;
		const capture_size = page_set_capture_size(page_set);
		const capture_preset = capture_preset_for(capture_size);
		// A validation failure round-trips the edit form's in-progress values
		// (including a long pasted step list) rather than losing them - only
		// the page set the error belongs to gets its edit-form values back.
		const edit_form = page_set_edit_form?.page_set_id === page_set.id ? page_set_edit_form : undefined;
		const { kind, urls, steps_text, unavailable_urls } = is_workflow_page_set(page_set)
			? { kind: "workflow" as const, urls: [] as string[], steps_text: JSON.stringify(page_set.steps, null, "\t"), unavailable_urls: [] as string[] }
			: { kind: "urls" as const, urls: page_set.urls, steps_text: "", unavailable_urls: page_set.urls.filter((url) => !sitemap_url_set.has(url)) };
		return {
			...page_set,
			kind: edit_form?.kind ?? kind,
			name: edit_form?.name ?? page_set.name,
			capture_width: capture_size.width,
			capture_height: capture_size.height,
			capture_preset: capture_preset.id,
			capture_size_label: `${capture_preset.label} · ${capture_size.width}×${capture_size.height}`,
			page_count: page_set_page_count(page_set),
			urls,
			steps_text: edit_form?.steps_text ?? steps_text,
			unavailable_urls,
			baseline_page_count: baseline?.page_count,
		};
	}));
	const show_create_dialog = open_create_dialog && sitemap.error === "";
	const ctx = await create_ctx(req, import.meta.dir);
	return render("index", {
		data: {
			projects,
			active_project,
			active_page_set_id: active_page_set?.id,
			sitemap_pages: sitemap_page_views,
			sitemap_error: sitemap.error,
			capture_presets: visual_capture_presets,
			page_sets: page_set_views,
			page_set_create_form,
			open_create_dialog: show_create_dialog,
			project_form,
			project_form_error,
			project_edit_form,
			project_edit_form_error,
			page_set_form_error,
			page_set_error_id,
			page_error,
			busy: false,
			...(await sidebar_props(ctx.request_url)),
		},
		ctx,
		status,
	});
}

export async function get_projects_page(req: BunRequest): Promise<Response> {
	const request_url = new URL(req.url);
	const open_create_dialog = request_url.searchParams.get("create") === "1";
	return render_projects_page(req, { open_create_dialog });
}

export async function post_create_project(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const name_value = params.get("name");
	const path_value = params.get("path");
	const base_url_value = params.get("base_url");
	const form = {
		name: name_value ? name_value.trim() : "",
		path: path_value ? path_value.trim() : "",
		base_url: base_url_value ? base_url_value.trim() : "",
	};

	try {
		await create_project(form.name, form.path, form.base_url);
		const locale = resolve_locale(req);
		const target = localized_url("/projects", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_projects_page(req, { project_form: form, project_form_error: message, status: 400 });
	}
}

export async function post_update_project(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const project_id = params.get("project_id");
	const name_value = params.get("name");
	const path_value = params.get("path");
	const base_url_value = params.get("base_url");
	const form = {
		name: name_value ? name_value.trim() : "",
		path: path_value ? path_value.trim() : "",
		base_url: base_url_value ? base_url_value.trim() : "",
	};
	if (!project_id) return new Response("QA project id is required.", { status: 400 });
	try {
		await update_project(project_id, form.name, form.path, form.base_url);
		const locale = resolve_locale(req);
		const target = localized_url("/projects", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_projects_page(req, { project_edit_form: form, project_edit_form_error: message, status: 400 });
	}
}

export async function post_duplicate_project(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const project_id = params.get("project_id");
	if (!project_id) return new Response("QA project id is required.", { status: 400 });
	try {
		await duplicate_project(project_id);
		const locale = resolve_locale(req);
		const target = localized_url("/projects", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_projects_page(req, { page_error: message, status: 404 });
	}
}

export async function post_set_active_project(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const project_id = params.get("project_id");
	if (!project_id) return new Response("QA project id is required.", { status: 400 });
	const next = params.get("next")?.trim() || "/";
	try {
		await set_active_project_id(project_id);
		const locale = resolve_locale(req);
		const target = localized_url(next, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Response(message, { status: 400 });
	}
}

export async function post_delete_project(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const project_id = params.get("project_id");
	if (!project_id) return new Response("QA project id is required.", { status: 400 });
	try {
		await delete_project(project_id);
		const locale = resolve_locale(req);
		const target = localized_url("/projects", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_projects_page(req, { page_error: message, status: 404 });
	}
}

function page_set_input_from_form(name: string, kind: "urls" | "workflow", urls: string[], steps_text: string, capture_preset: string, auto_evidence: boolean, auto_recording: boolean): Page_set_input {
	const preset = resolve_capture_preset(capture_preset);
	if (!preset) throw new Error("Select a capture size.");
	return {
		name,
		kind,
		capture_width: preset.width,
		capture_height: preset.height,
		auto_evidence,
		auto_recording,
		...(kind === "workflow" ? { steps: parse_workflow_steps(steps_text) } : { urls }),
	};
}

export async function post_create_page_set(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const name = params.get("name")?.trim() ?? "";
	const kind = params.get("kind") === "workflow" ? "workflow" as const : "urls" as const;
	const urls = params.getAll("urls");
	const steps_text = params.get("steps") ?? "";
	const capture_preset = params.get("capture_preset")?.trim() || "desktop";
	const auto_evidence = params.get("auto_evidence") === "on";
	const auto_recording = params.get("auto_recording") === "on";
	try {
		const project = await require_active_project();
		// A workflow's navigate targets are checked against the project's own
		// origin in the store, not the sitemap - a login POST target legitimately
		// isn't in sitemap.xml the way a URL-list page has to be.
		if (kind === "urls") await validate_sitemap_urls(project, urls);
		const input = page_set_input_from_form(name, kind, urls, steps_text, capture_preset, auto_evidence, auto_recording);
		const page_set = await create_page_set(project.id, input);
		await set_active_page_set_id(project.id, page_set.id);
		const locale = resolve_locale(req);
		const target = localized_url("/projects", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_projects_page(req, { page_set_form_error: message, status: 400, page_set_create_form: { name, kind, urls, steps_text, capture_preset, auto_evidence, auto_recording }, open_create_dialog: true });
	}
}

export async function post_update_page_set(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const page_set_id = params.get("page_set_id");
	const name = params.get("name")?.trim() ?? "";
	const kind = params.get("kind") === "workflow" ? "workflow" as const : "urls" as const;
	const urls = params.getAll("urls");
	const steps_text = params.get("steps") ?? "";
	const capture_preset = params.get("capture_preset")?.trim() || "desktop";
	const auto_evidence = params.get("auto_evidence") === "on";
	const auto_recording = params.get("auto_recording") === "on";
	if (!page_set_id) return new Response("Page set selection is required.", { status: 400 });
	try {
		const project = await require_active_project();
		await require_page_set(project.id, page_set_id);
		if (kind === "urls") await validate_sitemap_urls(project, urls);
		const input = page_set_input_from_form(name, kind, urls, steps_text, capture_preset, auto_evidence, auto_recording);
		await update_page_set(page_set_id, input);
		const locale = resolve_locale(req);
		const target = localized_url("/projects", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_projects_page(req, {
			page_set_form_error: message,
			page_set_error_id: page_set_id,
			status: 400,
			page_set_edit_form: { page_set_id, name, kind, urls, steps_text, capture_preset, auto_evidence, auto_recording },
		});
	}
}

export async function post_delete_page_set(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const page_set_id = params.get("page_set_id");
	if (!page_set_id) return new Response("Page set selection is required.", { status: 400 });
	try {
		const page_set = await find_page_set(page_set_id);
		if (!page_set) throw new Error("Page set not found.");
		await delete_page_set(page_set_id);
		const locale = resolve_locale(req);
		const target = localized_url("/projects", locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return render_projects_page(req, { page_set_form_error: message, status: 404 });
	}
}

export async function post_set_active_page_set(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const page_set_id = params.get("page_set_id")?.trim() || "";
	const next = params.get("next")?.trim() || "/";
	try {
		const project = await require_active_project();
		if (page_set_id) await set_active_page_set_id(project.id, page_set_id);
		else await clear_active_page_set_selection();
		const locale = resolve_locale(req);
		const target = localized_url(next, locale);
		return Response.redirect(target, 303);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Response(message, { status: 400 });
	}
}

export const projects_crud = { "/projects": { GET: get_projects_page }, "/projects/create": { POST: post_create_project }, "/projects/update": { POST: post_update_project }, "/projects/delete": { POST: post_delete_project }, "/projects/duplicate": { POST: post_duplicate_project }, "/projects/active": { POST: post_set_active_project }, "/projects/page-sets/create": { POST: post_create_page_set }, "/projects/page-sets/update": { POST: post_update_page_set }, "/projects/page-sets/delete": { POST: post_delete_page_set } };

export const route_definitions: RouteDefinition[] = [
	{
		url: "/projects",
		crud: projects_crud,
		nav_title_key: "reeqa.projects",
		module: "system",
		nav_module: null,
	},
];
