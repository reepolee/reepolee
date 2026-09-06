import { default_locale, locales } from "$config/supported_locales";
import { feature_paths, redirect_from_referer } from "$lib/crud_routes";
import { make_toast } from "$lib/cookies";
import { get_available_tables } from "$lib/global_scopes";
import { create_toast_cookie } from "$lib/cookies";
import { get_locale_from_request, localized_url } from "$lib/route";
import { translations } from "$lib/i18n";
import { sql_log } from "$lib/logger";
import { get_available_modules } from "$lib/modules";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { reload_route_maps } from "$lib/route_map";
import { notify_server_reload } from "$lib/server_notify";
import type { BunRequest } from "bun";

import { upsert_translation } from "../translations/sql";
import { enable_archive } from "./config";
import { validate } from "./validation_server";
import { archive_record, get_record_by_id, restore_record, update_record } from "./sql";

const feature = "global_scopes";
const route_prefix = "";

const { base_path, entity_path } = feature_paths(route_prefix, feature);

// ---------------------------------------------------------------------------
// POST /global_scopes/:id/edit
// ---------------------------------------------------------------------------

export async function post_global_scopes_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = Number(req.params.id || 0);
	const body = await req.text();
	const _lang = get_locale_from_request(req) || default_locale;
	const params = new URLSearchParams(body);
	const action = params.get("_action");
	const return_url_from_form = params.get("_return_url");

	const bp = base_path();
	let redirect_url = localized_url(bp, _lang);
	if (return_url_from_form?.includes(bp)) {
		redirect_url = return_url_from_form;
	} else {
		const referer_redirect = redirect_from_referer(req, base_path());
		if (referer_redirect) redirect_url = referer_redirect;
	}

	if (action === "generate_scope_translations") {
		const scope_record = await get_record_by_id(id);
		if (scope_record) {
			const key_path = `scopes.${scope_record.scope_key}`;
			const route_part = scope_record.feature_name || scope_record.table_name;
			const namespace = scope_record.module_code ? `${scope_record.module_code}.${route_part}` : route_part;
			for (const locale of locales) {
				await upsert_translation(locale, namespace, key_path, scope_record.display_name || scope_record.scope_key);
			}
			await translations.reload();
			reload_route_maps(translations.all);
			await notify_server_reload(false, Bun.env.MAIN_APP_URL);

			const toast_cookie = make_toast("toast-scope-translations", {
				message: `Scope translations created for "${scope_record.scope_key}".`,
				type: "green",
				duration: 3000,
			});

			const headers = new Headers({ Location: localized_url(entity_path(id), _lang) });
			headers.append("Set-Cookie", toast_cookie.toString());
			return new Response(null, { status: 303, headers });
		}
		return Response.redirect(localized_url(entity_path(id), _lang), 303);
	}

	if (action === "restore") {
		if (!enable_archive) {
			return Response.json({ error: "Restore is disabled." }, { status: 403 });
		}
		try {
			const restored = await restore_record(id);
			if (restored) {
				sql_log({ s: "Restore", t: `${feature}`, id }, ctx.user?.username);
				return Response.redirect(redirect_url, 303);
			}
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		} catch (error) {
			console.error("Error restoring record:", error);
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		}
	}

	if (action === "archive") {
		if (!enable_archive) {
			return Response.json({ error: "Archive is disabled." }, { status: 403 });
		}
		try {
			const archived = await archive_record(id, ctx.user?.id ?? null);
			if (archived) {
				sql_log({ s: "Archive", t: `${feature}`, id }, ctx.user?.username);
				return Response.redirect(redirect_url, 303);
			}
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		} catch (error) {
			const existing_record = await get_record_by_id(id);
			if (!existing_record) {
				return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
			}

			const error_message = error instanceof Error && error.message.includes("foreign key") ? "Cannot archive this record because it's referenced by other records." : "Error archiving record.";

			const [module_options, table_options] = await Promise.all([get_available_modules(), get_available_tables()]);
			let module_part = existing_record.module_code || "";
			let table_part = existing_record.table_name || "";
			if (!module_part && table_part.includes(".")) {
				const dot_idx = table_part.indexOf(".");
				module_part = table_part.slice(0, dot_idx);
				table_part = table_part.slice(dot_idx + 1);
			}

			return render("form", {
				data: {
					page_title: ctx.translations.ui?.edit_title,
					record: { ...existing_record, module_code: module_part, table: table_part },
					form_errors: error_message,
					errors: {},
					action: entity_path(id),
					module_options,
					table_options,
					enable_archive,
				},
				ctx,
			});
		}
	}

	const data = {
		module_code: params.get("module_code")?.trim() || "",
		feature_name: params.get("feature_name")?.trim() || "",
		table_name: params.get("table")?.trim() || "",
		scope_key: params.get("scope_key")?.trim() || "",
		display_name: params.get("display_name")?.trim() || "",
		where_clause: params.get("where_clause")?.trim() || "",
		sort_order: params.get("sort_order")?.trim() || "",
		is_default: params.get("is_default")?.trim() || "",
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0 || !valid_data) {
		const existing_record = await get_record_by_id(id);
		if (!existing_record) {
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		}
		const [module_options, table_options] = await Promise.all([get_available_modules(), get_available_tables()]);
		return render("form", {
			data: {
				page_title: ctx.translations.ui?.edit_title,
				record: { ...existing_record, ...data, table: data.table_name },
				errors,
				action: entity_path(id),
				module_options,
				table_options,
				enable_archive,
			},
			ctx,
		});
	}

	let record;
	try {
		record = await update_record(id, valid_data);
		sql_log({ s: "Update", t: `${feature}`, r: { ...record } }, ctx.user?.username);
	} catch (error) {
		const error_key = error instanceof Error && error.message.toLowerCase().includes("duplicate entry") ? "duplicate_key" : "error_creating_record";
		const error_message = ctx.translations.errors[error_key];
		const [module_options, table_options] = await Promise.all([get_available_modules(), get_available_tables()]);
		return render("form", {
			data: {
				record: { ...data, table: data.table_name },
				errors,
				form_errors: error_message,
				action: entity_path(id),
				module_options,
				table_options,
				enable_archive,
			},
			ctx,
		});
	}

	if (!record) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	const cookie = create_toast_cookie({
		record_id: record.id,
		feature,
		message: ctx.translations.messages.record_updated,
		type: "green",
		user: ctx.user?.display_name,
	});

	const headers = new Headers({ Location: redirect_url });
	headers.append("Set-Cookie", cookie.toString());
	return new Response(null, { status: 303, headers });
}
