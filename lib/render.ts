import { join } from "node:path";

import type { RequestContext, Toast } from "$lib/request_context";

import { env_switch_on } from "$config/env_vars";
import type { Dev_app_link } from "$config/apps";
import { active_locales, default_locale, locale_names } from "$config/supported_locales";
import { get_cookie } from "$lib/cookies";
import { now_iso_str } from "$lib/temporal";
import { get_or_bundle } from "$lib/bundle_cache";

import { translations } from "./i18n";
import { inject_inspector, inject_issue_reporter, inject_live_reload } from "./livereload";
import { detect_locale } from "./route_map";
import { create_template_helpers } from "./template_helpers";
import { visible_apps } from "$platform/app_switcher";

type Engine = { render: (name: string, data?: Record<string, any>) => Promise<string>; clear_cache?: () => void; };

let render_template: ((template: string, data?: Record<string, any>) => Promise<string>) | null = null;
let is_dev = false;
let base_dev_apps: readonly Dev_app_link[] = [];

// Off by default: when enabled, groups external <script src> tags into one
// immediate and one deferred bundle per page. Set GROUP_JS=true (or "on") to
// enable; unset or "false" leaves each script tag as its own request
// (styles/links still relocate to head either way). Read lazily (not cached
// at module load) so tests can toggle it per-file.
function is_group_js_enabled(): boolean {
	return env_switch_on("GROUP_JS");
}

export function get_collapsed_nav_modules(cookie_value: string | null): string[] {
	if (!cookie_value) return [];

	try {
		const parsed_value: unknown = JSON.parse(cookie_value);
		if (!Array.isArray(parsed_value)) return [];

		const module_names = parsed_value.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 100);
		return module_names.slice(0, 100);
	} catch {
		return [];
	}
}

/**
 * Relocate out-of-head <style>, <link rel=stylesheet>, and <script src>
 * blocks into <head>. Also bundle external scripts into a single cached file.
 *
 * Deliberately regex-based: an HTMLRewriter port was evaluated (2026-07) and
 * rejected - a minimal HTMLRewriter pass alone (parse + 3 handlers, no
 * relocation) benchmarked 2.6-3.3x slower than this whole function
 * (16.6us vs 6.4us on an 8KB page, 186us vs 56us on 125KB).
 */
export async function move_styles_and_scripts_to_head(html_content: string): Promise<string> {
	const style_regex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
	const script_with_src_regex = /<script\b[^>]*\ssrc\s*=[^>]*>[\s\S]*?<\/script>/gi;
	const link_stylesheet_regex = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi;

	const blocks: string[] = [];

	const head_match = html_content.match(/<head[^>]*>[\s\S]*?<\/head>/i);
	const get_head_range = () => {
		if (!head_match || head_match.index == null) return null;
		return { start: head_match.index, end: head_match.index + head_match[0].length };
	};

	const head_range = get_head_range();

	function is_inside_head(offset: number) {
		if (!head_range) return false;
		return offset >= head_range.start && offset < head_range.end;
	}

	// styles
	html_content = html_content.replace(style_regex, (match, offset) => {
		if (is_inside_head(offset)) return match;
		blocks.push(match);
		return "";
	});

	// stylesheet links
	html_content = html_content.replace(link_stylesheet_regex, (match, offset) => {
		if (is_inside_head(offset)) return match;
		blocks.push(match);
		return "";
	});

	let bundled_tags = "";

	if (is_group_js_enabled()) {
		// Extract script srcs for bundling - both in-head and out-of-head
		// scripts are collected and replaced with two bundled tags: one
		// immediate, one deferred, grouped by whether the original tag had a
		// defer attribute.
		const immediate_srcs: string[] = [];
		const deferred_srcs: string[] = [];

		html_content = html_content.replace(script_with_src_regex, (full_match) => {
			const src_match = /\ssrc\s*=\s*["']([^"']+)["']/.exec(full_match);
			if (!src_match) return "";

			const src = src_match[1] ?? "";
			const is_deferred = /\bdefer\b/i.test(full_match);
			(is_deferred ? deferred_srcs : immediate_srcs).push(src);
			return "";
		});

		// Bundle external scripts - immediate and deferred groups stay separate
		// so deferred scripts don't run before inline scripts that depend on
		// globals defined by the immediate group.
		if (immediate_srcs.length > 0) {
			const bundled_path = await get_or_bundle(immediate_srcs);
			if (bundled_path) bundled_tags += `<script src="${bundled_path}"></script>\n`;
		}
		if (deferred_srcs.length > 0) {
			const bundled_path = await get_or_bundle(deferred_srcs);
			if (bundled_path) bundled_tags += `<script src="${bundled_path}" defer></script>\n`;
		}
	} else {
		// Grouping disabled - relocate out-of-head scripts to head unchanged,
		// one tag per source, no bundling.
		html_content = html_content.replace(script_with_src_regex, (full_match, offset) => {
			if (is_inside_head(offset)) return full_match;
			blocks.push(full_match);
			return "";
		});
	}

	if (!blocks.length && !bundled_tags) return html_content;

	const blocks_content = [...blocks, bundled_tags].filter(Boolean).join("\n");

	if (/<head[^>]*>/i.test(html_content)) {
		html_content = html_content.replace(/<\/head>/i, `${blocks_content}\n</head>`);
	} else if (/<html[^>]*>/i.test(html_content)) {
		html_content = html_content.replace(/<html[^>]*>/i, (m) => `${m}\n<head>\n${blocks_content}\n</head>`);
	} else {
		html_content = `<head>\n${blocks_content}\n</head>\n${html_content}`;
	}

	return html_content;
}
export function initialize_render(engine: Engine, base_data: Record<string, any>) {
	is_dev = base_data.is_dev;
	base_dev_apps = Array.isArray(base_data.dev_apps) ? base_data.dev_apps : [];
	render_template = async (template: string, data: Record<string, any> = {}) => { return await engine.render(template, { ...base_data, ...data }); };
}

export function get_render() {
	if (!render_template) { throw new Error("render not initialized"); }
	return render_template;
}

export type RenderOptions = {
	data?: Record<string, any>;
	status?: number;
	headers?: Record<string, string>;
	debug_redact_keys?: string[];
	// The request context is mandatory - every render is request-scoped.
	// create_ctx(req, import.meta.dir) at the top of the handler produces it.
	ctx: RequestContext;
	is_partial?: boolean;
};

/**
 * Preferred-language mismatch overrides: when the requested URL belongs to a
 * different language than the user's preferred one, the mismatch banner
 * strings are rendered in the PREFERRED language so the user can read them.
 * Returns {} when there is no mismatch.
 */
function preferred_locale_overrides(path_locale: string | null, preferred_locale: string | null, ctx_translations: Record<string, any>): Record<string, any> {
	if (!path_locale || !preferred_locale || path_locale === preferred_locale) return {};

	const pref_raw = translations.get(preferred_locale);
	const pref = pref_raw?.routes ?? pref_raw;
	const pref_ui = pref?.ui ?? {};
	const pref_actions = pref?.actions ?? {};
	const loc_name = pref_ui?.locale_names?.[path_locale] ?? locale_names[path_locale];

	return {
		path_locale,
		path_locale_name: loc_name,
		locale_preferred: preferred_locale,
		translations: {
			...ctx_translations,
			ui: {
				...ctx_translations.ui,
				lang_mismatch_title: pref_ui?.lang_mismatch_title,
				lang_mismatch_body: pref_ui?.lang_mismatch_body,
			},
			actions: {
				...ctx_translations.actions,
				lang_mismatch_switch: pref_actions?.lang_mismatch_switch,
				lang_mismatch_dismiss: pref_actions?.lang_mismatch_dismiss,
			},
		},
	};
}

export async function render_to_string(template: string, options: RenderOptions): Promise<string> {
	const { data = {}, ctx, debug_redact_keys = [], is_partial = false } = options;
	if (!render_template) { throw new Error("render not initialized"); }

	// Resolve request data from context
	const relative_url = ctx.request_url;

	// Resolve CSRF token from request headers (set by csrf_mw middleware)
	const csrf_token: string = ctx.req?.headers?.get("X-CSRF-Token") || "";
	const nav_modules_cookie = ctx.req ? get_cookie(ctx.req, "nav_collapsed_modules") : null;
	const collapsed_nav_modules = get_collapsed_nav_modules(nav_modules_cookie);

	// Detect language of the requested URL path
	const path_locale: string | null = detect_locale(relative_url ?? "");

	// Absolute origin of the current request, for metadata that requires
	// absolute URLs (hreflang alternates, Open Graph). Empty when unavailable.
	let request_origin = "";
	try {
		request_origin = ctx.req ? new URL(ctx.req.url).origin : "";
	} catch {
		request_origin = "";
	}

	// Prepare complete render data first
	const _render_data = {
		...(relative_url ? { request_url: relative_url } : {}),
		prefix: ctx.prefix,
		csrf_token,
		locale: ctx.locale,
		dark_mode: ctx.dark_mode,
		theme_class: ctx.theme_class,
		active_locales: active_locales.filter(Boolean),
		default_locale,
		request_origin,
		locale_names,
		user: ctx.user,
		toasts: ctx.toasts,
		collapsed_nav_modules,
		rendered_at: now_iso_str(),
		translations: ctx.translations,
		...data,
		...preferred_locale_overrides(path_locale, ctx.preferred_locale, ctx.translations),
	};

	const debug_render_data: Record<string, any> = { ..._render_data };
	for (const key of debug_redact_keys) {
		if (key in debug_render_data) { debug_render_data[key] = "[redacted]"; }
	}

	const configured_dev_apps = (_render_data as Record<string, any>).dev_apps ?? base_dev_apps;
	const render_data: Record<string, any> = {
		..._render_data,
		...(is_dev ? { dev_apps: visible_apps({ current_user: ctx.user }, configured_dev_apps) } : { dev_apps: [] }),
		...(is_dev ? {
			toJSON: JSON.stringify(debug_render_data),
			toPrettyJSON: JSON.stringify(debug_render_data, null, 2),
		} : {}),
	};

	// Create helpers with complete data including locale, user, etc.
	const merged_helpers = create_template_helpers(render_data);
	render_data.helpers = merged_helpers;

	// Resolve the template path through the mounted template namespace. The
	// translation namespace may carry an app-only prefix such as "reeman", but
	// mounted templates are still addressed by their module code.
	let resolved_template = template;
	const template_dir = ctx?.template_dir ?? ctx?.route_dir;
	if (template_dir) {
		const clean_name = template.endsWith(".ree") ? template.slice(0, -4) : template;
		if (clean_name.startsWith("./") || clean_name.startsWith("../")) {
			resolved_template = join(template_dir.replace(/\\/g, "/"), clean_name).replace(/\\/g, "/");
		} else {
			resolved_template = `${template_dir}/${clean_name}`;
		}
	}

	let _html;
	try {
		_html = await render_template(resolved_template, render_data);
	} catch (err) {
		if (template_dir && err instanceof Error && err.message.startsWith("Template not found")) {
			console.debug(`Template not found at "${resolved_template}", falling back to "${template}"`);
			_html = await render_template(template, render_data);
		} else {
			throw err;
		}
	}

	// Skip full-document post-processing for partial (streamed) fragments
	let html = is_partial ? _html : await move_styles_and_scripts_to_head(_html);

	if (is_dev && !is_partial) {
		html = await inject_live_reload(html);
		html = await inject_issue_reporter(html);
		html = await inject_inspector(html);
	}

	return html;
}

export async function render(template: string, options: RenderOptions): Promise<Response> {
	const { headers = {}, status = 200, ctx } = options;

	const html = await render_to_string(template, options);

	const response_headers = new Headers({ "Content-Type": "text/html", ...headers });

	// HTML is request/user-scoped and never cacheable; without this, a reverse
	// proxy or the browser can serve a stale page (e.g. after a selector POST
	// redirects back to the same URL). Assets are cached separately by the
	// static/S3 handlers with their own immutable headers.
	response_headers.set("Cache-Control", "no-store");

	// Clear toast cookies if present
	ctx?.toasts?.forEach((element: Toast) => response_headers.append("Set-Cookie", `${element.key}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`));

	return new Response(html, { status, headers: response_headers });
}
