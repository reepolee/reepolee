import { create_toast_cookie } from "$lib/cookies";
import { localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

function get_lang(req: BunRequest): string { return req?.headers?.get("X-Lang") || "en"; }

import { create_user_session } from "../helpers";
import { require_auth, resolve_session } from "../middleware";
import { destroy_user_sessions } from "../session_store";
import { get_user_by_id, update_user_password } from "../sql";
import { validate, validate_touched } from "./validation_server";

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export const password_crud = {
	"/password": { GET: get_auth_password, POST: post_auth_password },
	"/password/validate": { POST: post_auth_password_validate },
};

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

export async function get_auth_password(req: BunRequest): Promise<Response> {
	const [ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const guard = require_auth(auth_ctx, req);
	if (guard) return guard;

	return render("form", { data: { action: "/password" }, ctx });
}

export async function post_auth_password(req: BunRequest): Promise<Response> {
	const [ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const guard = require_auth(auth_ctx, req);
	if (guard) return guard;

	const params = new URLSearchParams(await req.text());

	const data = {
		current_password: params.get("current_password") || "",
		password: params.get("password") || "",
		password_confirm: params.get("password_confirm") || "",
	};

	const [errors, _valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) { return render("form", { data: { errors }, ctx }); }

	const user_id = auth_ctx.session?.user_id;
	if (!user_id) {
		const lang = get_lang(req);
		return Response.redirect(localized_url("/login", lang), 303);
	}
	const user_row = await get_user_by_id(user_id);
	if (!user_row) {
		const lang = get_lang(req);
		return Response.redirect(localized_url("/login", lang), 303);
	}

	const current_valid = await Bun.password.verify(_valid_data.current_password, user_row.hashed_password);

	if (!current_valid) {
		const form_error = ctx.translations.errors.incorrect_password;

		return render("form", { data: { errors, form_error, ..._valid_data }, ctx });
	}

	const new_hashed = await Bun.password.hash(_valid_data.password);
	const password_updated = await update_user_password(user_id, new_hashed, user_row.hashed_password);
	if (!password_updated) { return new Response("Unable to update password", { status: 500 }); }
	await destroy_user_sessions(user_id);

	const session_cookie = await create_user_session(user_row);

	const toast_data = {
		record_id: 1,
		feature: "",
		message: ctx.translations.messages.successful_save,
		type: "green",
		user: ctx.user?.display_name,
	};

	const toast_cookie = create_toast_cookie(toast_data);

	const headers = new Headers({ Location: "/" });

	headers.append("Set-Cookie", session_cookie.toString());
	headers.append("Set-Cookie", toast_cookie.toString());

	return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// Validate endpoint
// ---------------------------------------------------------------------------
export async function post_auth_password_validate(req: BunRequest): Promise<Response> {
	const _ctx = await create_ctx(req, import.meta.dir);
	const body: any = await req.json();
	const touched: string[] = body.touched || [];

	const data = {
		current_password: body.current_password || "",
		password: body.password || "",
		password_confirm: body.password_confirm || "",
	};

	const [errors, _valid_data] = validate_touched(data, touched, _ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}
