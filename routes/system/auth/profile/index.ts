import { create_toast_cookie } from "$lib/cookies";
import { localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

function get_lang(req: BunRequest): string { return req?.headers?.get("X-Lang") || "en"; }

import { save_avatar_upload } from "../avatar";
import { require_auth, resolve_session } from "../middleware";
import { refresh_session } from "../session_store";
import { get_user_by_id, to_public_user, update_user_profile } from "../sql";
import { validate, validate_touched } from "./validation_server";

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export const profile_crud = {
	"/profile": { GET: get_auth_profile, POST: post_auth_profile },
	"/profile/validate": { POST: post_auth_profile_validate },
};

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export async function get_auth_profile(req: BunRequest): Promise<Response> {
	const [ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const guard = require_auth(auth_ctx, req);
	if (guard) return guard;

	const user = await get_user_by_id(auth_ctx.session?.user_id);
	if (!user) {
		const lang = get_lang(req);
		return Response.redirect(localized_url("/login", lang), 303);
	}

	return render("form", { data: { profile_user: to_public_user(user), action: "/profile" }, ctx });
}

export async function post_auth_profile(req: BunRequest): Promise<Response> {
	const [ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const guard = require_auth(auth_ctx, req);
	if (guard) return guard;

	const form_data = await req.formData();

	const data: Record<string, string> = {
		name: (form_data.get("name") as string)?.trim() || "",
		nickname: (form_data.get("nickname") as string)?.trim() || "",
	};

	const avatar_file = form_data.get("avatar") as File | null;

	const user_row = await get_user_by_id(auth_ctx.session?.user_id);
	if (!user_row) {
		const lang = get_lang(req);
		return Response.redirect(localized_url("/login", lang), 303);
	}

	const [errors, _valid_data] = validate(data, ctx.translations.errors);

	const profile_user = to_public_user(user_row);
	const action = "/profile";

	if (Object.keys(errors).length > 0) { return render("form", { data: { ..._valid_data, errors, profile_user, action }, ctx }); }

	// Avatar upload (not part of Zod schema - it's a File, not a string)
	let avatar_filename: string | undefined;
	if (avatar_file && avatar_file.size > 0) {
		try {
			avatar_filename = await save_avatar_upload(avatar_file);
		} catch (err) {
			console.error("avatar_upload_failed:", err);
			const form_error = "avatar_upload_failed";
			return render("form", { data: { ..._valid_data, errors, form_error, profile_user, action }, ctx });
		}
	}

	await update_user_profile(auth_ctx.session?.user_id, {
		name: _valid_data.name,
		nickname: _valid_data.nickname,
		avatar_filename,
	});

	// Refresh session so layout reflects new name/nickname/avatar immediately
	if (auth_ctx.session_id) {
		const display_name = _valid_data.nickname || _valid_data.name || auth_ctx.session?.email;
		const session_updates: Record<string, string> = {
			name: _valid_data.name,
			nickname: _valid_data.nickname,
			display_name,
			avatar_filename: avatar_filename ?? auth_ctx.session?.avatar_filename,
		};
		await refresh_session(auth_ctx.session_id, session_updates as any);
	}

	const toast_data = {
		record_id: 1,
		feature: "",
		message: ctx.translations.messages.successful_save,
		type: "green",
		user: ctx.user?.display_name,
	};

	const toast_cookie = create_toast_cookie(toast_data);

	const headers = new Headers({ Location: "/" });

	headers.append("Set-Cookie", toast_cookie.toString());

	return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// Validate endpoint
// ---------------------------------------------------------------------------
export async function post_auth_profile_validate(req: BunRequest): Promise<Response> {
	const _ctx = await create_ctx(req, import.meta.dir);
	const body = await req.json();
	const touched: string[] = body.touched || [];

	const data = { name: body.name || "", nickname: body.nickname || "" };

	const [errors, _valid_data] = validate_touched(data, touched, _ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}
