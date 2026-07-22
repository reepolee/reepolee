import { run_bulk_delete } from "$lib/crud_routes";
import { get_available_tables, resolve_session_variables, SESSION_VARIABLE_PATHS } from "$lib/global_scopes";
import { get_available_modules } from "$lib/modules";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { get_record_by_id as get_user_by_id, get_users_select_options } from "$routes/system/users/sql";
import type { BunRequest } from "bun";

import { enable_delete } from "./schema/table";
import { validate_touched } from "./schema/validation_server";
import { delete_record, get_record_by_id } from "./sql";

// ---------------------------------------------------------------------------
// POST /global_scopes/validate
// ---------------------------------------------------------------------------

export async function post_global_scopes_validate(req: BunRequest): Promise<Response> {
	const [body, ctx] = await Promise.all([req.json(), create_ctx(req, import.meta.dir)]);
	const touched: string[] = body.touched || [];

	const data = {
		module_code: body.module_code || "",
		feature_name: body.feature_name || "",
		table_name: body.table || "",
		scope_key: body.scope_key || "",
		display_name: body.display_name || "",
		where_clause: body.where_clause || "",
		sort_order: body.sort_order || "",
		is_default: body.is_default || "",
	};

	const [errors] = validate_touched(data, touched, ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}

// ---------------------------------------------------------------------------
// GET /global_scopes/new
// ---------------------------------------------------------------------------

export async function get_global_scopes_new(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const [module_options, table_options, user_options] = await Promise.all([get_available_modules(), get_available_tables(), get_users_select_options()]);

	return render("form", {
		data: {
			title: "New record",
			record: {
				feature_name: "",
				table_name: "",
				module_code: "",
				table: "",
				scope_key: "",
				display_name: "",
				where_clause: "",
				sort_order: "",
				is_default: -1,
			},
			errors: {
				feature_name: "",
				table_name: "",
				scope_key: "",
				display_name: "",
				where_clause: "",
				sort_order: "",
				is_default: "",
			},
			action: "/system/global_scopes",
			module_options,
			table_options,
			user_options,
			session_variables: SESSION_VARIABLE_PATHS,
			enable_delete,
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// GET /global_scopes/:id/edit
// ---------------------------------------------------------------------------

export async function get_global_scopes_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = req.params.id ? String(req.params.id) : "";
	const record = await get_record_by_id(id);

	if (!record) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	let module_part = record.module_code || "";
	let table_part = record.table_name || "";
	if (!module_part && table_part.includes(".")) {
		const dot_idx = table_part.indexOf(".");
		module_part = table_part.slice(0, dot_idx);
		table_part = table_part.slice(dot_idx + 1);
	}

	const route_part = record.feature_name || record.table_name;
	const ns_for_translations = record.module_code ? `${record.module_code}.${route_part}` : route_part;

	const [module_options, table_options, user_options] = await Promise.all([get_available_modules(), get_available_tables(), get_users_select_options()]);

	const translations_url = `/system/translations/${encodeURIComponent(ns_for_translations)}/scopes/edit?from=${encodeURIComponent(ns_for_translations)}`;

	return render("form", {
		data: {
			title: `Edit ${ns_for_translations}`,
			record: { ...record, module_code: module_part, table: table_part },
			back_route: `/system/global_scopes?there_should_be_back_params`,
			errors: {
				table_name: "",
				scope_key: "",
				display_name: "",
				where_clause: "",
				sort_order: "",
				is_default: "",
			},
			action: `/system/global_scopes/${record.id}/edit`,
			module_options,
			table_options,
			user_options,
			translations_url,
			session_variables: SESSION_VARIABLE_PATHS,
			enable_delete,
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// POST /global_scopes/test-scope
// ---------------------------------------------------------------------------

export async function post_global_scopes_test_scope(req: BunRequest): Promise<Response> {
	try {
		const body = await req.json();
		const where_clause: string = body.where_clause?.trim() || "";
		const test_user_id: number = parseInt(body.test_user_id, 10);

		if (!where_clause) {
			return Response.json({ error: "where_clause is required" }, { status: 400 });
		}

		if (Number.isNaN(test_user_id)) {
			return Response.json({ error: "test_user_id is required" }, { status: 400 });
		}

		const user_record = await get_user_by_id(test_user_id);
		if (!user_record) {
			return Response.json({ error: "User not found" }, { status: 404 });
		}

		const preview_ctx = {
			req: {} as any,
			lang: "en",
			user: {
				id: user_record.id,
				email: user_record.email ?? "",
				name: user_record.name ?? "",
				nickname: user_record.nickname ?? "",
				username: user_record.username ?? "",
				avatar_filename: user_record.avatar_filename ?? "",
				modules_tags: user_record.modules_tags ?? "",
				display_name: user_record.nickname || user_record.name || user_record.email || "",
			},
			toasts: [],
			prefix: null,
			route_dir: null,
			request_url: undefined,
			locale: undefined,
			preferred_lang: null,
		} as any;

		const resolved_clause = resolve_session_variables(where_clause, preview_ctx);

		return Response.json({ resolved_clause }, { status: 200 });
	} catch (error) {
		console.error("Error previewing scope:", error);
		return Response.json({ error: "Preview failed" }, { status: 500 });
	}
}

// ---------------------------------------------------------------------------
// POST /global_scopes/bulk-delete
// ---------------------------------------------------------------------------

export async function post_global_scopes_bulk_delete(req: BunRequest): Promise<Response> {
	if (!enable_delete) {
		return Response.json({ error: "Bulk delete is disabled." }, { status: 403 });
	}
	const ctx = await create_ctx(req, import.meta.dir);
	return run_bulk_delete(req, ctx, {
		feature: "global_scopes",
		table_name: TABLE_NAME,
		delete_one: (id) => delete_record(Number(id)),
	});
}
