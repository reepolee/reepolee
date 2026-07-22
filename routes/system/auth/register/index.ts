import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

import { create_user_session } from "../helpers";
import { get_user_by_invitation_code, verify_and_register_user } from "../sql";
import { validate, validate_touched } from "./validation_server";

// ---------------------------------------------------------------------------
// URL param extraction
// ---------------------------------------------------------------------------

/**
 * Extract username and invitation_code from:
 * /register/<username>/<invitation_code>
 *
 * Uses filter(Boolean) so the leading empty segment from split("/") is removed:
 * ["register", "<username>", "<invitation_code>"]
 * [0]          [1]            [2]
 */
function extract_register_params(req: BunRequest): { username: string; invitation_code: string; } {
	const parts = new URL(
		req.url,
		"http://localhost",
	).pathname.split("/").filter(Boolean);
	return {
		username: decodeURIComponent(parts[1] || "").toLowerCase(),
		invitation_code: decodeURIComponent(parts[2] || ""),
	};
}

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export const register_crud = {
	"/register/:username/:invitation_code": { GET: get_auth_register, POST: post_auth_register },
	"/register/validate": { POST: post_auth_register_validate },
};

// ---------------------------------------------------------------------------
// Registration (invite-only)
// Route: /register/:username/:invitation_code
// ---------------------------------------------------------------------------
export async function get_auth_register(req: BunRequest): Promise<Response> {
	const { username, invitation_code } = extract_register_params(req);
	const [ctx, user] = await Promise.all([create_ctx(req, import.meta.dir), get_user_by_invitation_code(invitation_code)]);

	if (!user || user.username.toLowerCase() !== username) {
		return render("form", {
			data: {
				username: "",
				action: `/register/${username}/${invitation_code}`,
				invitation_code: "",
				form_error: ctx.translations.ui.invalid_link,
			},
			ctx,
		});
	}

	if (user.verified_at) {
		return render("form", {
			data: {
				username: "",
				action: `/register/${username}/${invitation_code}`,
				invitation_code: "",
				form_error: ctx.translations.ui.already_used,
			},
			ctx,
		});
	}

	return render("form", {
		data: {
			username,
			email: user.email,
			action: `/register/${username}/${invitation_code}`,
			invitation_code,
		},
		ctx,
	});
}

export async function post_auth_register(req: BunRequest): Promise<Response> {
	const { username, invitation_code } = extract_register_params(req);
	const ctx = await create_ctx(req, import.meta.dir);
	const body_text = await req.text();
	const params = new URLSearchParams(body_text);

	const data = {
		name: params.get("name")?.trim() || "",
		password: params.get("password") || "",
		password_confirm: params.get("password_confirm") || "",
	};

	const user = await get_user_by_invitation_code(invitation_code);

	// Re-enforce the same guards as the GET handler - a POST must never be able
	// to register (or re-register) an account that the GET view would reject.
	// Without this, anyone knowing a (username, invitation_code) pair could POST
	// to overwrite the name/password of an already-verified account.
	const invalid_link = !user || user.username.toLowerCase() !== username;
	const already_used = user?.verified_at;
	if (invalid_link || already_used) {
		return render("form", {
			data: {
				username: "",
				action: `/register/${username}/${invitation_code}`,
				invitation_code: "",
				form_error: invalid_link ? ctx.translations.ui.invalid_link : ctx.translations.ui.already_used,
			},
			ctx,
		});
	}

	const [errors, _valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		return render("form", {
			data: {
				username,
				email: user.email,
				action: `/register/${username}/${invitation_code}`,
				invitation_code,
				errors,
				form_error: "",
			},
			ctx,
		});
	}

	const hashed_password = await Bun.password.hash(_valid_data.password);
	const updated = await verify_and_register_user(user.id, _valid_data.name, hashed_password);
	if (!updated) {
		return render("form", {
			data: {
				username,
				email: user.email,
				action: `/register/${username}/${invitation_code}`,
				invitation_code,
				form_error: ctx.translations.ui.invalid_link,
			},
			ctx,
		});
	}

	const session_cookie = await create_user_session(updated);

	const headers = new Headers({ Location: "/" });

	headers.append("Set-Cookie", session_cookie.toString());

	return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// Validate endpoint
// ---------------------------------------------------------------------------
export async function post_auth_register_validate(req: BunRequest): Promise<Response> {
	const [_ctx, body] = await Promise.all([create_ctx(req, import.meta.dir), req.json() as Promise<any>]);
	const touched: string[] = body.touched || [];

	const data = {
		name: body.name || "",
		password: body.password || "",
		password_confirm: body.password_confirm || "",
	};

	const [errors, _valid_data] = validate_touched(data, touched, _ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}
