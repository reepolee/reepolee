import { default_language } from "$config/supported_languages";
import { cache } from "$lib/cache";
import { create_toast_cookie } from "$lib/cookies";
import { empty_strings, feature_paths, pick_body_fields, redirect_from_referer, run_bulk_delete } from "$lib/crud_routes";
import { get_lang_from_request, localized_url } from "$lib/route";
import { sql_log } from "$lib/logger";
import { get_available_modules } from "$lib/modules";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

import { validate, validate_touched } from "./schema/validation_server";
import { delete_record, get_record_by_id, update_record } from "./sql";

export { enable_delete } from "./schema/table";

const TABLE_NAME = "users";
const feature = "users";
const route_prefix = "/system";

const { base_path, entity_path } = feature_paths(route_prefix, feature);

// The one list every record/errors/body shape derives from.
const USER_FIELDS = [
	"email",
	"name",
	"nickname",
	"username",
	"avatar_filename",
	"verified_at",
	"hashed_password",
	"invitation_code",
	"modules_tags",
	"previous_hashed_password",
] as const;

// ---------------------------------------------------------------------------
// POST /users/validate
// ---------------------------------------------------------------------------

export async function post_users_validate(req: BunRequest): Promise<Response> {
	const [body, ctx] = await Promise.all([req.json() as Promise<Record<string, any>>, create_ctx(req, import.meta.dir)]);
	const touched: string[] = body.touched || [];

	const data = pick_body_fields(body, USER_FIELDS);

	const [errors] = validate_touched(data, touched, ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}

// ---------------------------------------------------------------------------
// GET /users/new
// ---------------------------------------------------------------------------

export async function get_users_new(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const module_options = await get_available_modules();

	return render("form", {
		data: {
			title: "New record",
			record: empty_strings(USER_FIELDS),
			errors: empty_strings(USER_FIELDS),
			action: base_path(),
			module_options,
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// GET /users/:id/edit
// ---------------------------------------------------------------------------

export async function get_users_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = Number(req.params.id || 0);
	const record = await get_record_by_id(id);

	if (!record) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	const module_options = await get_available_modules();
	const bp = base_path();

	return render("form", {
		data: {
			title: `Edit ${record.email}`,
			record,
			back_route: `${bp}?there_should_be_back_params`,
			errors: empty_strings(USER_FIELDS),
			action: entity_path(record.id),
			module_options,
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// POST /users/:id/edit
// ---------------------------------------------------------------------------

export async function post_users_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = Number(req.params.id || 0);
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
	const module_options = await get_available_modules();
	const params = new URLSearchParams(body);
	const action = params.get("_action");
	const return_url_from_form = params.get("_return_url");
	const save_action = params.get("_save_action");

	const bp = base_path();
	let redirect_url = localized_url(bp, _lang);
	if (save_action === "stay") {
		redirect_url = localized_url(entity_path(id), _lang);
	} else if (return_url_from_form?.includes(bp)) {
		redirect_url = return_url_from_form;
	} else {
		const referer_redirect = redirect_from_referer(req, base_path());
		if (referer_redirect) redirect_url = referer_redirect;
	}

	if (action === "delete") {
		try {
			const deleted = await delete_record(id);
			if (deleted) {
				sql_log({ s: "Delete", t: `${feature}`, id }, ctx.user?.username);
				await cache.invalidate(TABLE_NAME);
				return Response.redirect(redirect_url, 303);
			}
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		} catch (error) {
			const existing_record = await get_record_by_id(id);
			if (!existing_record) {
				return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
			}
			const error_message = error instanceof Error && error.message.includes("foreign key") ? "Cannot delete this record because it's referenced by other records." : "Error deleting record.";
			return render("form", {
				data: {
					title: `Edit ${existing_record.name}`,
					record: existing_record,
					form_errors: error_message,
					errors: {},
					action: entity_path(id),
					module_options,
				},
				ctx,
			});
		}
	}

	const existing_record = await get_record_by_id(id);
	if (!existing_record) {
		return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
	}

	const form_fields = USER_FIELDS.filter((f) => f !== "hashed_password" && f !== "previous_hashed_password");
	const data = {
		...Object.fromEntries(form_fields.map((f) => [f, params.get(f)?.trim() || ""])),
		hashed_password: existing_record.hashed_password,
		previous_hashed_password: existing_record.previous_hashed_password,
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		return render("form", {
			data: {
				title: `Edit ${existing_record.email}`,
				record: { ...existing_record, ...data },
				errors,
				action: entity_path(id),
				module_options,
			},
			ctx,
		});
	}

	let record;
	try {
		record = await update_record(id, valid_data);
		sql_log({ s: "Update", t: `${feature}`, r: { ...record } }, ctx.user?.username);
		await cache.invalidate(TABLE_NAME);
	} catch (error) {
		const error_key = error instanceof Error && error.message.toLowerCase().includes("duplicate entry") ? "duplicate_key" : "error_creating_record";
		const error_message = ctx.translations.errors[error_key];
		return render("form", {
			data: {
				record: data,
				errors,
				form_errors: error_message,
				action: entity_path(id),
				module_options,
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

// ---------------------------------------------------------------------------
// POST /users/bulk-delete
// ---------------------------------------------------------------------------

export async function post_users_bulk_delete(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	return run_bulk_delete(req, ctx, {
		feature,
		table_name: TABLE_NAME,
		delete_one: (id) => delete_record(Number(id)),
	});
}
