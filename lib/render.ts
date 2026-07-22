import { join } from "node:path";

import { active_languages, language_names } from "$config/supported_languages";
import { get_cookie } from "$lib/cookies";
import { now_iso_str } from "$lib/temporal";

import { translations } from "./i18n";
import { inject_live_reload } from "./livereload";
import { detect_lang } from "./route_map";
import { create_template_helpers } from "./template_helpers";

type Engine = { render: (name: string, data?: Record<string, any>) => Promise<string>; clear_cache?: () => void; };

let render_template: ((template: string, data?: Record<string, any>) => Promise<string>) | null = null;
let is_dev = false;

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
 * blocks into <head>.
 *
 * Deliberately regex-based: an HTMLRewriter port was evaluated (2026-07) and
 * rejected - a minimal HTMLRewriter pass alone (parse + 3 handlers, no
 * relocation) benchmarked 2.6-3.3x slower than this whole function
 * (16.6us vs 6.4us on an 8KB page, 186us vs 56us on 125KB).
 */
export function move_styles_and_scripts_to_head(html_content: string): string {
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

	// scripts with src
	html_content = html_content.replace(script_with_src_regex, (match, offset) => {
		if (is_inside_head(offset)) return match;
		blocks.push(match);
		return "";
	});

	if (!blocks.length) return html_content;

	const blocks_content = blocks.join("\n");

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
function preferred_lang_overrides(path_lang: string | null, preferred_lang: string | null, ctx_translations: Record<string, any>): Record<string, any> {
	if (!path_lang || !preferred_lang || path_lang === preferred_lang) return {};

	const pref_raw = translations.get(preferred_lang);
	const pref = pref_raw?.routes ?? pref_raw;
	const pref_ui = pref?.ui ?? {};
	const pref_actions = pref?.actions ?? {};
	const loc_name = pref_ui?.language_names?.[path_lang] ?? language_names[path_lang];

	return {
		path_lang,
		path_lang_name: loc_name,
		lang_preferred: preferred_lang,
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
	const { data = {}, ctx, is_partial = false } = options;
	if (!render_template) { throw new Error("render not initialized"); }

	// Resolve request data from context
	const relative_url = ctx.request_url;

	// Resolve CSRF token from request headers (set by csrf_mw middleware)
	const csrf_token: string = ctx.req?.headers?.get("X-CSRF-Token") || "";
	const nav_modules_cookie = ctx.req ? get_cookie(ctx.req, "nav_collapsed_modules") : null;
	const collapsed_nav_modules = get_collapsed_nav_modules(nav_modules_cookie);

	// Detect language of the requested URL path
	const path_lang: string | null = detect_lang(relative_url ?? "");

	// Prepare complete render data first
	const _render_data = {
		...(relative_url ? { request_url: relative_url } : {}),
		prefix: ctx.prefix,
		lang: ctx.lang,
		csrf_token,
		locale: ctx.locale,
		dark_mode: ctx.dark_mode,
		theme_class: ctx.theme_class,
		active_languages: active_languages.filter(Boolean),
		language_names,
		user: ctx.user,
		toasts: ctx.toasts,
		collapsed_nav_modules,
		rendered_at: now_iso_str(),
		translations: ctx.translations,
		...data,
		...preferred_lang_overrides(path_lang, ctx.preferred_lang, ctx.translations),
	};

	const render_data = {
		..._render_data,
		...(is_dev ? {
			toJSON: JSON.stringify(_render_data),
			toPrettyJSON: JSON.stringify(_render_data, null, 2),
		} : {}),
	};

	// Create helpers with complete data including lang, user, etc.
	const merged_helpers = create_template_helpers(render_data);
	render_data.helpers = merged_helpers;

	// Resolve template path via ctx.route_dir
	let resolved_template = template;
	if (ctx?.route_dir) {
		const clean_name = template.endsWith(".ree") ? template.slice(0, -4) : template;
		if (clean_name.startsWith("./") || clean_name.startsWith("../")) {
			resolved_template = join(ctx.route_dir.replace(/\\/g, "/"), clean_name).replace(/\\/g, "/");
		} else {
			resolved_template = `${ctx.route_dir}/${clean_name}`;
		}
	}

	let _html;
	try {
		_html = await render_template(resolved_template, render_data);
	} catch (err) {
		if (ctx?.route_dir && err instanceof Error && err.message.startsWith("Template not found")) {
			console.debug(`Template not found at "${resolved_template}", falling back to "${template}"`);
			_html = await render_template(template, render_data);
		} else {
			throw err;
		}
	}

	// Skip full-document post-processing for partial (streamed) fragments
	let html = is_partial ? _html : move_styles_and_scripts_to_head(_html);

	if (is_dev && !is_partial) { html = await inject_live_reload(html); }

	return html;
}

export async function render(template: string, options: RenderOptions): Promise<Response> {
	const { headers = {}, status = 200, ctx } = options;

	const html = await render_to_string(template, options);

	const response_headers = new Headers({ "Content-Type": "text/html", ...headers });

	// Clear toast cookies if present
	ctx?.toasts?.forEach((element) => response_headers.append("Set-Cookie", `${element.key}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`));

	return new Response(html, { status, headers: response_headers });
}
