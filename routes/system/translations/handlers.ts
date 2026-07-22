import { default_language, languages } from "$config/supported_languages";
import { feature_paths } from "$lib/crud_routes";
import { language_locales } from "$config/supported_languages";
import { cache } from "$lib/cache";
import { make_toast } from "$lib/cookies";
import { format_bulk_delete_message } from "$lib/format";
import { get_lang_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { translations } from "$lib/i18n";
import { sql_log } from "$lib/logger";
import { create_ctx } from "$lib/request_context";
import { reload_route_maps } from "$lib/route_map";
import { type BunRequest, Cookie } from "bun";

import { namespace_templates } from "./helpers";
import { delete_groups, delete_key, delete_namespace, delete_translation, upsert_translation } from "./sql";

const TABLE_NAME = "translations";
const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "/system";

const { base_path } = feature_paths(route_prefix, feature);

// Add Namespace

export async function post_translations_add_namespace(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const _lang = get_lang_from_request(req) || default_language;

	const namespace = params.get("namespace")?.trim() || "";
	if (!namespace) { return Response.redirect(localized_url(base_path(), _lang), 303); }

	// Check which templates were selected
	const selected_templates: string[] = [];

	for (const tpl of namespace_templates) {
		if (params.get(`tpl_${tpl.id}`) === "on") { selected_templates.push(tpl.id); }
	}

	if (selected_templates.length > 0) {
		// Insert all template keys for all languages
		for (const tpl_id of selected_templates) {
			const tpl = namespace_templates.find((t) => t.id === tpl_id);
			if (!tpl) continue;
			for (const [key_path, en_value] of Object.entries(tpl.keys)) {
				const full_key = key_path;
				for (const lang of languages) {
					await upsert_translation(lang, namespace, full_key, en_value);
				}
			}
		}
	} else {
		// Insert a placeholder so the namespace appears
		await upsert_translation("en", namespace, "_placeholder", "");
	}

	await translations.reload();
	reload_route_maps(translations.all);
	sql_log({ s: "Create", t: `${feature}`, r: { namespace } }, ctx.user?.username);

	await cache.invalidate(TABLE_NAME);

	const toast_cookie = make_toast("toast-ns-added", {
		message: `Namespace "${namespace}" added with ${selected_templates.length} template(s).`,
		type: "green",
		duration: 3000,
	}, "/");

	const headers = new Headers({ Location: localized_url(`${base_path()}?ns_group=${encodeURIComponent(namespace + "::")}`, _lang) });
	headers.append("Set-Cookie", toast_cookie.toString());
	return new Response(null, { status: 303, headers });
}

// Delete Namespace

export async function post_translations_delete_namespace(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const _lang = get_lang_from_request(req) || default_language;

	const namespace = params.get("namespace")?.trim() || "";
	if (!namespace) { return Response.redirect(localized_url(base_path(), _lang), 303); }

	await delete_namespace(namespace);
	await translations.reload();
	reload_route_maps(translations.all);
	sql_log({ s: "Delete", t: `${feature}/namespace`, r: { namespace } }, ctx.user?.username);
	await cache.invalidate(TABLE_NAME);

	const toast_cookie = make_toast("toast-ns-deleted", {
		message: `Namespace "${namespace}" deleted.`,
		type: "green",
		duration: 3000,
	}, "/");

	const headers = new Headers({ Location: localized_url(base_path(), _lang) });
	headers.append("Set-Cookie", toast_cookie.toString());
	return new Response(null, { status: 303, headers });
}

// Add Group

export async function post_translations_add_group(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const _lang = get_lang_from_request(req) || default_language;

	const namespace = params.get("namespace")?.trim() || "";
	const group_name = params.get("group_name")?.trim() || "";
	const first_key = params.get("first_key")?.trim() || "";
	if (!namespace || !group_name) { return Response.redirect(localized_url(base_path(), _lang), 303); }

	// Build the full key path: group_name.key (or just group_name if no key)
	const full_key = first_key ? `${group_name}.${first_key}` : group_name;

	// Insert for each language that has a value
	for (const lang of languages) {
		const value = params.get(`value__${lang}`)?.trim() || "";
		if (value) { await upsert_translation(lang, namespace, full_key, value); }
	}

	await translations.reload();
	reload_route_maps(translations.all);
	sql_log({ s: "Create", t: `${feature}/group`, r: { namespace, group_name } }, ctx.user?.username);
	await cache.invalidate(TABLE_NAME);

	const toast_cookie = make_toast("toast-group-added", {
		message: `Group "${group_name}" added.`,
		type: "green",
		duration: 3000,
	}, "/");

	const headers = new Headers({ Location: localized_url(`${base_path()}?ns_group=${encodeURIComponent(namespace + "::" + group_name)}`, _lang) });
	headers.append("Set-Cookie", toast_cookie.toString());
	return new Response(null, { status: 303, headers });
}

// Edit

// Bulk Delete

export async function post_translations_bulk_delete(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const msg = ctx.translations.messages ?? {};
	const lang = get_lang_from_request(req) || default_language;
	const locale = language_locales[lang] || "en-US";

	try {
		const body = await req.json() as Record<string, any>;
		const raw_ids: string[] = body.ids || [];

		if (!Array.isArray(raw_ids) || raw_ids.length === 0) {
			return Response.json({ error: msg.bulk_delete_no_ids || "No groups selected." }, { status: 400 });
		}

		// Parse checkbox values: format is "namespace::parent_path"
		const groups: { namespace: string; parent_path: string; }[] = [];
		for (const raw of raw_ids) {
			const delim = raw.indexOf("::");
			if (delim < 0) continue;
			const ns = raw.slice(0, delim);
			const pp = raw.slice(delim + 2);
			if (ns) groups.push({ namespace: ns, parent_path: pp || "" });
		}

		if (groups.length === 0) {
			return Response.json({ error: msg.bulk_delete_no_ids || "No valid groups selected." }, { status: 400 });
		}

		// Track per-namespace deletions for logging
		const ns_set = new Set(groups.map((g) => g.namespace));
		for (const ns of ns_set) {
			const ns_groups = groups.filter((g) => g.namespace === ns);
			sql_log({
				s: "BulkDelete",
				t: `${feature}/groups`,
				r: { namespace: ns, groups: ns_groups.map((g) => g.parent_path || "(root)") },
			}, ctx.user?.username);
		}

		const deleted_count = await delete_groups(groups);
		await translations.reload();
		reload_route_maps(translations.all);
		await cache.invalidate(TABLE_NAME);

		const message = format_bulk_delete_message(msg, deleted_count, 0, "translation", locale);

		const toast_cookie = make_toast("toast-bulk-delete", { message, type: "green", duration: 4000 });

		return Response.json({ deleted: deleted_count, errors: 0, message }, { status: 200, headers: { "Set-Cookie": toast_cookie.toString() } });
	} catch (err) {
		console.error("⚠️  Bulk delete failed:", err);
		return Response.json({ error: msg.bulk_delete_failed || "Bulk delete failed." }, { status: 500 });
	}
}

// Delete Key

export async function post_translations_delete_key(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const params = new URLSearchParams(body);
	const _lang = get_lang_from_request(req) || default_language;

	const namespace = params.get("namespace")?.trim() || "";
	const key_path = params.get("key_path")?.trim() || "";

	if (!namespace || !key_path) { return Response.redirect(localized_url(base_path(), _lang), 303); }

	await delete_key(namespace, key_path);
	await translations.reload();
	reload_route_maps(translations.all);
	sql_log({ s: "Delete", t: `${feature}/key`, r: { namespace, key_path } }, ctx.user?.username);
	await cache.invalidate(TABLE_NAME);

	// Redirect back to the same group edit form (other keys still exist)
	const parent_path = key_path.lastIndexOf(".") >= 0 ? key_path.slice(0, key_path.lastIndexOf(".")) : "_";
	const redirect_to = `${base_path()}/${encodeURIComponent(namespace)}/${encodeURIComponent(parent_path)}/edit`;
	return Response.redirect(localized_url(redirect_to, _lang), 303);
}

// Inline Save

export async function post_translations_inline_save(req: BunRequest): Promise<Response> {
	try {
		const body = await req.json() as Record<string, any>;
		const namespace = String(body.namespace ?? "").trim();
		const key_path = String(body.key_path ?? "").trim();
		const lang = String(body.lang ?? "").trim();
		const value = String(body.value ?? "").trim();

		if (!namespace || !key_path || !lang) {
			return Response.json({ error: "Missing required fields: namespace, key_path, lang" }, { status: 400 });
		}

		if (value) {
			await upsert_translation(lang, namespace, key_path, value);
		} else {
			await delete_translation(lang, namespace, key_path);
		}

		// Batch invalidations after updates
		await translations.reload();
		reload_route_maps(translations.all);
		await cache.invalidate(TABLE_NAME);

		return Response.json({ ok: true, namespace, key_path, lang, value }, { status: 200 });
	} catch (err) {
		console.error("Inline save failed:", err);
		return Response.json({ error: String(err) }, { status: 500 });
	}
}
