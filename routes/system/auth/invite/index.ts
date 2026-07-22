import { localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { uuid_v7 } from "$lib/uuid";
import type { BunRequest } from "bun";

import { require_auth, require_module, resolve_session } from "../middleware";
import { create_invited_user, get_user_by_invitation_code, get_user_by_username } from "../sql";

function get_lang(req: BunRequest): string { return req?.headers?.get("X-Lang") || "en"; }

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export const invite_crud = {
	"/invite": { GET: get_auth_invite, POST: post_auth_invite },
	"/invite/confirm/:token": { GET: get_auth_invite_confirm },
	"/invite/validate": { POST: post_auth_invite_validate },
};

// ---------------------------------------------------------------------------
// Admin: invite a new user
// ---------------------------------------------------------------------------

export async function get_auth_invite(req: BunRequest): Promise<Response> {
	const [ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const auth_guard = require_auth(auth_ctx, req);
	if (auth_guard) return auth_guard;
	const module_guard = require_module(auth_ctx, "admin");
	if (module_guard) return module_guard;

	return render("form", { data: { action: "/invite" }, ctx });
}

export async function post_auth_invite(req: BunRequest): Promise<Response> {
	const [ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const auth_guard = require_auth(auth_ctx, req);
	if (auth_guard) return auth_guard;
	const module_guard = require_module(auth_ctx, "admin");
	if (module_guard) return module_guard;

	const params = new URLSearchParams(await req.text());
	const email = params.get("email")?.trim().toLowerCase() || "";
	const username = params.get("username")?.trim().toLowerCase() || "";

	if (!email) { return render("form", { data: { email, username, form_error: ctx.translations.errors.email_required }, ctx }); }

	if (!username) { return render("form", { data: { email, username, form_error: ctx.translations.errors.username_required }, ctx }); }

	const existing = await get_user_by_username(username);
	if (existing) { return render("form", { data: { email, username, form_error: ctx.translations.errors.username_exists }, ctx }); }

	const invitation_code = uuid_v7();
	await create_invited_user(email, username, invitation_code);

	const lang = get_lang(req);
	const confirm_url = localized_url(`/invite/confirm/${invitation_code}`, lang);

	return new Response(null, { status: 303, headers: { Location: confirm_url } });
}

// ---------------------------------------------------------------------------
// Validate endpoint (client-side validation from FormController)
// ---------------------------------------------------------------------------
export async function post_auth_invite_validate(req: BunRequest): Promise<Response> {
	const [_ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const auth_guard = require_auth(auth_ctx, req);
	if (auth_guard) return auth_guard;
	const module_guard = require_module(auth_ctx, "admin");
	if (module_guard) return module_guard;

	const body = await req.json();

	const username = body.username?.trim().toLowerCase() || "";

	const errors: Record<string, string> = {};

	if (!username) {
		errors.username = _ctx.translations.errors?.username_required || "Username is required.";
	} else {
		const existing = await get_user_by_username(username);
		if (existing) { errors.username = _ctx.translations.errors?.username_exists || "A user with this username already exists."; }
	}

	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}

export async function get_auth_invite_confirm(req: BunRequest): Promise<Response> {
	const [ctx, auth_ctx] = await Promise.all([create_ctx(req, import.meta.dir), resolve_session(req)]);
	const auth_guard = require_auth(auth_ctx, req);
	if (auth_guard) return auth_guard;
	const module_guard = require_module(auth_ctx, "admin");
	if (module_guard) return module_guard;

	// Extract invitation_code from /invite/confirm/:invitation_code
	const parts = new URL(
		req.url,
		"http://localhost",
	).pathname.split("/").filter(Boolean);
	const invitation_code = parts[2] || "";

	const user = await get_user_by_invitation_code(invitation_code);
	if (!user) { return render("confirm", { data: { form_error: ctx.translations.errors.invitation_not_found }, ctx }); }

	const lang = get_lang(req);
	const register_url = localized_url(`/register/${encodeURIComponent(user.username)}/${user.invitation_code}`, lang);
	// Normalize DB timestamp (old: "YYYY-MM-DD HH:MM:SS", new: "YYYY-MM-DDTHH:MM:SSZ") to Temporal-compatible ISO
	const created_norm = user.created_at.replace(" ", "T") + (user.created_at.includes("Z") || user.created_at.includes("+") ? "" : "Z");
	const invited_at = Temporal.Instant.from(created_norm).toLocaleString("en-GB", {
		dateStyle: "medium",
		timeStyle: "short",
	});

	return render("confirm", {
		data: {
			error: "",
			invited_email: user.email,
			invited_username: user.username,
			invited_at,
			register_url,
		},
		ctx,
	});
}
