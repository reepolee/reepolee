import { localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

import { build_clear_cookie, get_session_id_from_request } from "../cookies";
import { create_user_session } from "../helpers";
import { destroy_session } from "../session_store";
import { get_user_by_username } from "../sql";
import { validate, validate_touched } from "./validation_server";

function get_lang(req: BunRequest): string { return req?.headers?.get("X-Lang") || "en"; }

// Fixed hash used to equalize password-verify timing when the account is
// absent or has no password set, so login timing does not reveal whether a
// username exists (user enumeration). Computed once with the current
// Bun.password defaults so its cost matches real verifications.
const DUMMY_PASSWORD_HASH = await Bun.password.hash("timing-equalizer-not-a-real-password");

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export const login_crud = {
	"/login": { GET: get_auth_login, POST: post_auth_login },
	"/login/validate": { POST: post_auth_login_validate },
	"/logout": { POST: post_auth_logout },
};

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function get_auth_login(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const url = new URL(req.url);
	const redirect = url.searchParams.get("redirect") || "";

	return render("form", { data: { action: "/login", redirect }, ctx });
}

export async function post_auth_login(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body_text = await req.text();
	const params = new URLSearchParams(body_text);

	const data = {
		username: params.get("username")?.trim() || "",
		password: params.get("password") || "",
	};

	const [errors, _valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		return render("form", {
			data: { action: "/login", ..._valid_data, errors, form_error: "" },
			ctx,
		});
	}

	const user = await get_user_by_username(_valid_data.username);

	// Single generic failure response for every credential failure (unknown
	// user, no password set, unverified account, wrong password) so the
	// response never reveals which one occurred. Always run a password verify -
	// against a dummy hash when there's no real one - so timing does not leak
	// whether the username exists.
	const invalid_credentials = () =>
		render("form", {
			data: {
				action: "/login",
				..._valid_data,
				form_error: ctx.translations.errors.invalid_username_or_password || "Invalid username or password.",
			},
			ctx,
		});

	const hash_to_check = user?.hashed_password || DUMMY_PASSWORD_HASH;
	const password_valid = await Bun.password.verify(_valid_data.password, hash_to_check);

	if (!user?.hashed_password || !user.verified_at || !password_valid) { return invalid_credentials(); }

	const session_cookie = await create_user_session(user);

	// Determine redirect target - same-origin check to prevent open redirect
	let redirect_target = "/";
	const raw_redirect = params.get("redirect");
	if (raw_redirect) {
		try {
			const redirect_url = new URL(raw_redirect);
			const current_origin = new URL(req.url).origin;
			if (redirect_url.origin === current_origin) { redirect_target = raw_redirect; }
		} catch {
			// Invalid URL - ignore
		}
	}

	const headers = new Headers({ Location: redirect_target });

	headers.append("Set-Cookie", session_cookie.toString());

	return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// Validate endpoint
// ---------------------------------------------------------------------------

export async function post_auth_login_validate(req: BunRequest): Promise<Response> {
	const [_ctx, body] = await Promise.all([create_ctx(req, import.meta.dir), req.json()]);
	const touched: string[] = body.touched || [];

	const data = { username: body.username || "", password: body.password || "" };

	const [errors, _valid_data] = validate_touched(data, touched, _ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function post_auth_logout(req: BunRequest): Promise<Response> {
	const _ctx = await create_ctx(req, import.meta.dir);
	const session_id = get_session_id_from_request(req);
	if (session_id) { await destroy_session(session_id); }

	const lang = get_lang(req);
	const login_url = localized_url("/login", lang);

	const headers = new Headers({ Location: login_url, "Clear-Site-Data": "cache, storage" });

	headers.append("Set-Cookie", build_clear_cookie().toString());

	return new Response(null, { status: 303, headers });
}
