import { get_web_push_config } from "$config/web_push";
import { queue_web_push_notification, remove_web_push_subscription, save_web_push_subscription } from "$lib/web_push";
import { require_auth, require_module, resolve_session } from "$platform/auth/middleware";
import type { BunRequest } from "bun";

function json_error(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

async function current_user_id(req: BunRequest): Promise<number | null> {
	const auth_ctx = await resolve_session(req);
	return auth_ctx.current_user?.id ?? null;
}

export async function get_web_push_public_key(req: BunRequest): Promise<Response> {
	if ((await current_user_id(req)) === null) return json_error("Authentication required.", 401);
	const config = get_web_push_config();
	if (!config) return json_error("Web Push is not configured.", 404);
	return Response.json({ public_key: config.public_key });
}

export async function post_web_push_subscribe(req: BunRequest): Promise<Response> {
	const user_id = await current_user_id(req);
	if (user_id === null) return json_error("Authentication required.", 401);
	try {
		const subscription = await req.json() as unknown;
		await save_web_push_subscription(user_id, subscription);
		return Response.json({ ok: true });
	} catch (err) {
		return json_error(err instanceof Error ? err.message : "Invalid Web Push subscription.", 400);
	}
}

export async function post_web_push_test(req: BunRequest): Promise<Response> {
	const auth_ctx = await resolve_session(req);
	const auth_guard = require_auth(auth_ctx, req);
	if (auth_guard) return auth_guard;
	const module_guard = require_module(auth_ctx, "admin");
	if (module_guard) return module_guard;
	if (!get_web_push_config()) return json_error("Web Push is not configured.", 404);

	try {
		const queued = await queue_web_push_notification(auth_ctx.current_user!.id, {
			title: "Web Push test",
			message: "Web Push notifications are working.",
			link: "/",
		});
		return Response.json({ ok: true, queued });
	} catch (err) {
		return json_error(err instanceof Error ? err.message : "Unable to queue test notification.", 503);
	}
}

export async function post_web_push_unsubscribe(req: BunRequest): Promise<Response> {
	const user_id = await current_user_id(req);
	if (user_id === null) return json_error("Authentication required.", 401);
	try {
		const body = await req.json() as { endpoint?: unknown };
		if (typeof body.endpoint !== "string" || body.endpoint.length === 0 || body.endpoint.length > 4096) return json_error("Invalid endpoint.", 400);
		await remove_web_push_subscription(user_id, body.endpoint);
		return Response.json({ ok: true });
	} catch (err) {
		return json_error(err instanceof Error ? err.message : "Unable to unsubscribe.", 400);
	}
}

export const web_push_crud = {
	"/web-push/public-key": { GET: get_web_push_public_key },
	"/web-push/subscribe": { POST: post_web_push_subscribe },
	"/web-push/test": { POST: post_web_push_test },
	"/web-push/unsubscribe": { POST: post_web_push_unsubscribe },
};
