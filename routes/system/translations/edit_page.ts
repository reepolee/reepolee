/**
 * Translations admin - edit form (per-key values across all languages).
 * Split from handlers.ts to keep both files near the ~300-line convention.
 */

import { default_language, languages } from "$config/supported_languages";
import { cache } from "$lib/cache";
import { make_toast } from "$lib/cookies";
import { get_lang_from_request, localized_url } from "$lib/route";
import { feature_paths } from "$lib/crud_routes";
import { get_table_name_from_dir } from "$lib/helpers";
import { translations } from "$lib/i18n";
import { sql_log } from "$lib/logger";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { reload_route_maps } from "$lib/route_map";
import type { BunRequest } from "bun";

import { group_translations } from "./helpers";
import { delete_translation, get_all_translations, upsert_translation } from "./sql";

const TABLE_NAME = "translations";
const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "/system";

const { base_path } = feature_paths(route_prefix, feature);

export async function get_translations_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	// `_` is used as a URL-safe placeholder for empty values (both namespace and parent)
	let namespace = decodeURIComponent(req.params.namespace || "");
	let parent = decodeURIComponent(req.params.parent || "");
	if (namespace === "_") namespace = "root";
	if (parent === "_") parent = "";
	const _lang = get_lang_from_request(req) || default_language;

	if (!namespace) { return Response.redirect(localized_url(base_path(), _lang), 303); }

	const rows = await get_all_translations(namespace);
	const groups = group_translations(rows);

	// Find the matching group
	const group = groups.find((g) => g.parent_path === parent) || groups[0];
	if (!group) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	// Read the `from` query param to determine the correct return URL
	const url = new URL(req.url);
	const from_filter = url.searchParams.get("from") || "";
	const return_url = from_filter ? `${base_path()}?${from_filter}` : base_path();

	return render("form", {
		data: {
			title: `${namespace} / ${parent || "(root)"}`,
			namespace,
			parent_path: parent,
			keys: group.keys,
			languages,
			return_url,
			base_path: base_path(),
		},
		ctx,
	});
}

export async function post_translations_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const _lang = get_lang_from_request(req) || default_language;

	const namespace = params.get("namespace")?.trim() || "";
	const parent_path_val = params.get("parent_path")?.trim() || "";
	const return_url_from_form = params.get("_return_url")?.trim() || "";

	if (!namespace) { return Response.redirect(localized_url(base_path(), _lang), 303); }

	// Update existing keys
	const promises: Promise<unknown>[] = [];
	for (const [key, value] of params) {
		if (key.startsWith("value__")) {
			// Format: value__{lang}__{encoded_key_path}
			const rest = key.slice("value__".length);
			const delim = rest.indexOf("__");
			if (delim < 0) continue;
			const lang = rest.slice(0, delim);
			const encoded_key = rest.slice(delim + 2);
			const actual_key_path = decodeURIComponent(encoded_key);
			const val = value?.trim() || "";
			if (val) {
				promises.push(upsert_translation(lang, namespace, actual_key_path, val));
			} else {
				// Delete empty
				promises.push(delete_translation(lang, namespace, actual_key_path));
			}
		}
	}

	// Handle new key if provided
	const new_key_name = params.get("_new_key__name")?.trim() || "";
	if (new_key_name) {
		const full_key = parent_path_val ? `${parent_path_val}.${new_key_name}` : new_key_name;
		for (const lang of languages) {
			const value = params.get(`_new_key__value__${lang}`)?.trim() || "";
			if (value) { promises.push(upsert_translation(lang, namespace, full_key, value)); }
		}
	}

	await Promise.all(promises);
	await translations.reload();
	reload_route_maps(translations.all);
	sql_log({ s: "Update", t: `${feature}`, r: { namespace } }, ctx.user?.username);
	await cache.invalidate(TABLE_NAME);

	const redirect_to = return_url_from_form || `${base_path()}?ns_group=${encodeURIComponent(namespace + "::" + parent_path_val)}`;
	const toast_cookie = make_toast("toast-edited", {
		message: new_key_name ? `Key "${new_key_name}" added.` : "Translations updated.",
		type: "green",
		duration: 3000,
	}, "/");

	const headers = new Headers({ Location: localized_url(redirect_to, _lang) });
	headers.append("Set-Cookie", toast_cookie.toString());
	return new Response(null, { status: 303, headers });
}
