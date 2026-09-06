import { enqueue } from "$queue/index";
import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { uuid_v7 } from "$lib/uuid";
import type { BunRequest } from "bun";

import { require_auth, require_module, resolve_session } from "../middleware";
import { create_invited_user, get_user_by_invitation_code, get_user_by_username } from "../sql";

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export const invite_crud = {
	"/invite": { GET: get_auth_invite, POST: post_auth_invite },
	"/invite/confirm/:token": { GET: get_auth_invite_confirm },
	"/invite/validate": { POST: post_auth_invite_validate },
};

// Usernames are lowercased before validation, so only the lowercased charset is
// allowed. This blocks HTML/URL-special characters (which would otherwise be
// interpolated into the invitation email) from ever being stored.
const USERNAME_RE = /^[a-z0-9_-]+$/;

export function is_valid_username(username: string): boolean {
	return USERNAME_RE.test(username);
}

/**
 * Build the plain-text and HTML variants of the invitation email. The HTML
 * variant HTML-escapes the interpolated body before converting newlines to
 * <br>, so a username or URL can never inject markup into the invitee's inbox.
 */
export function build_invite_email(template: string, username: string, confirm_url: string): { body: string; html: string } {
	const body = template.replaceAll("{username}", username).replaceAll("{url}", confirm_url);
	const html = `<p>${Bun.escapeHTML(body).replaceAll("\n", "<br>")}</p>`;
	return { body, html };
}

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

	if (!email) { return render("form", { data: { action: "/invite", email, username, form_error: ctx.translations.errors.email_required }, ctx }); }

	if (!username) { return render("form", { data: { action: "/invite", email, username, form_error: ctx.translations.errors.username_required }, ctx }); }

	if (!is_valid_username(username)) { return render("form", { data: { action: "/invite", email, username, form_error: ctx.translations.errors.username_invalid }, ctx }); }

	const existing = await get_user_by_username(username);
	if (existing) { return render("form", { data: { action: "/invite", email, username, form_error: ctx.translations.errors.username_exists }, ctx }); }

	const invitation_code = uuid_v7();
	await create_invited_user(email, username, invitation_code);

	const locale = resolve_locale(req);
	const confirm_url = localized_url(`/invite/confirm/${invitation_code}`, locale);

	// Email the invitee through the queue worker (the send_email handler in
	// worker.ts). Best-effort: when the queue is unavailable the admin still
	// gets the confirm page with the registration link, as before.
	const email_subject = ctx.translations.email?.subject ?? "You've been invited";
	const { body: email_body, html: email_html } = build_invite_email(
		ctx.translations.email?.body ?? "Hi {username},\n\nComplete your registration here:\n{url}",
		username,
		confirm_url,
	);
	try {
		await enqueue({
			type: "send_email",
			payload: {
				to: email,
				subject: email_subject,
				body: email_body,
				html: email_html,
			},
		});
	} catch (error) {
		console.warn("[invite] Queue unavailable - invitation email not sent; confirm link shown to admin instead.");
	}

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

	const body = await req.json() as Record<string, any>;

	const username = body.username?.trim().toLowerCase() || "";

	const errors: Record<string, string> = {};

	if (!username) {
		errors.username = _ctx.translations.errors?.username_required || "Username is required.";
	} else if (!is_valid_username(username)) {
		errors.username = _ctx.translations.errors?.username_invalid || "Username can only contain lowercase letters, numbers, underscores, and hyphens.";
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

	const locale = resolve_locale(req);
	const register_url = localized_url(`/register/${encodeURIComponent(user.username)}/${user.invitation_code}`, locale);
	// Normalize DB timestamp (old: "YYYY-MM-DD HH:MM:SS", new: "YYYY-MM-DDTHH:MM:SSZ") to Temporal-compatible ISO
	const created_norm = user.created_at.replace(" ", "T") + (user.created_at.includes("Z") || user.created_at.includes("+") ? "" : "Z");
	const invited_at = Temporal.Instant.from(created_norm).toLocaleString("en-GB", { // en-GB is an Intl formatting idiom, not app locale identity
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
