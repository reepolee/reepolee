/**
 * Server helpers - shared logic extracted from server.ts for cleanliness and testability.
 *
 * These are pure(ish) utility functions used by both the dev and prod fetch handlers,
 * plus common endpoint handling shared across routing modes.
 */

import { join } from "node:path";

import { handle_rate_limits_get, handle_rate_limits_reset } from "$lib/admin/rate_limits";
import { handle_reload_translations } from "$lib/admin/reload_translations";
import { internal_admin_endpoints_enabled } from "$lib/admin/require_admin_auth";
import { get_storage_mode } from "$lib/env";
import { translations } from "$lib/i18n";
import type { WebSocketData } from "$lib/livereload";
import { get_local_storage_dir } from "$lib/local_storage";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { get_s3_mounts, handle_s3_request, is_s3_configured } from "$lib/s3";
import { wants_json } from "$lib/wants_json";
export { kill_previous_pid, log_server_addresses, start_server, type ServerStartOptions } from "./server_startup";

// ---------------------------------------------------------------------------
// Internal admin / debug endpoints
// ---------------------------------------------------------------------------

/**
 * Handle internal API endpoints (admin/debug routes that start with __).
 * These need to be checked before normal route matching in both dev and prod modes.
 *
 * Returns an endpoint response if the URL matches, or null to continue.
 */
export function handle_internal_endpoints(req: Request, url: URL): Response | Promise<Response> | null {
	if (!internal_admin_endpoints_enabled()) return null;

	if (req.method === "POST" && url.pathname === "/__reload-translations") { return handle_reload_translations(req); }

	if (req.method === "GET" && url.pathname === "/__rate-limits") { return handle_rate_limits_get(req); }

	if (req.method === "POST" && url.pathname === "/__reset-rate-limits") { return handle_rate_limits_reset(req); }

	return null;
}

// ---------------------------------------------------------------------------
// Shared fallback handling (S3 / local storage / static files / 404)
// ---------------------------------------------------------------------------

/**
 * Handle path resolution for a matched route handler - could be a plain
 * function or a method map ({ GET: fn, POST: fn }). Attaches `params` to
 * `req.params` so handlers can read :param segments (matches Bun's native
 * radix-tree behaviour).
 *
 * If the request carries Accept: application/json and the handler returns
 * a non-JSON response (HTML, redirect, etc.), the response is replaced with
 * a 404 JSON envelope. Handlers that support JSON return application/json
 * themselves and pass through unchanged.
 */
export async function call_route_handler(handler: unknown, req: Request, server?: Bun.Server<WebSocketData>, params: Record<string, string> = {}): Promise<Response> {
	// Always attach the matcher result. Bun requests may carry an undefined
	// params property when the custom dispatcher matches a route with captures;
	// assigning `{}` also keeps handlers safe on exact routes.
	(req as any).params = params;

	let response: Response;

	if (typeof handler === "function") {
		response = await (handler as (req: Request, server?: Bun.Server<WebSocketData>) => Response | Promise<Response>)(req, server);
	} else if (handler && typeof handler === "object") {
		const method_handler = (handler as Record<string, unknown>)[req.method];
		if (typeof method_handler === "function") {
			response = await (method_handler as (req: Request, server?: Bun.Server<WebSocketData>) => Response | Promise<Response>)(req, server);
		} else {
			response = new Response("Method Not Allowed", { status: 405 });
		}
	} else {
		response = new Response("Not Found", { status: 404 });
	}

	// If the client requested JSON but the handler returned HTML, respond with
	// a 404 JSON envelope so machine clients don't receive a page.
	//
	// Redirects are exempt. A 3xx is already a machine-readable answer, and the
	// locale switch (?locale=xx-yy) replies with one - swallowing it into a 404
	// made locale-aware API requests look like missing routes.
	if (wants_json(req)) {
		const is_redirect = response.status >= 300 && response.status < 400;
		const content_type = response.headers.get("Content-Type") || "";
		if (!is_redirect && !content_type.includes("application/json")) {
			return Response.json({ error: "not found" }, { status: 404 });
		}
	}

	return response;
}

// ---------------------------------------------------------------------------
// Fallback request pipeline (S3 -> local storage -> static files -> 404)
// ---------------------------------------------------------------------------

export type FallbackOptions = { is_dev: boolean; static_dirs: string[]; };

/**
 * Shared fallback handler - handles requests that aren't matched by routing.
 * Used by both dev and prod fetch handlers to avoid duplication.
 *
 * Pipeline order:
 * 1. S3 proxy (registered mounts)
 * 2. Local storage fallback for S3-mounted paths
 * 3. Static file serving from static_dirs (project static/, then route-local static/ dirs)
 * 4. 404 fallback with locale support
 */
export async function handle_fallback_requests(url: URL, req: Request, opts: FallbackOptions): Promise<Response> {
	const { is_dev, static_dirs } = opts;

	// S3 proxy - match registered mounts (avatars, uploads, etc.)
	const s3_response = await handle_s3_request(url, req);
	if (s3_response) return s3_response;

	// Local storage fallback for S3-mounted paths when S3 is not configured.
	const local_storage_dir = get_local_storage_dir();
	if (local_storage_dir) {
		for (const mount of get_s3_mounts()) {
			if (!url.pathname.startsWith(mount.url_prefix)) continue;

			const filename = decodeURIComponent(url.pathname.slice(mount.url_prefix.length));
			if (!filename || filename.includes("..") || filename.includes("\\\\")) continue;

			const key_prefix = mount.key_prefix ?? mount.url_prefix.replace(
				/^\//,
				""
			);
			const local_prefix = key_prefix || mount.bucket;
			const local_file = join(local_storage_dir, local_prefix, filename);
			try {
				if (await Bun.file(local_file).exists()) {
					const cache = mount.immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600";
					return new Response(Bun.file(local_file), {
						status: 200,
						headers: { "Cache-Control": cache },
					});
				}
			} catch {
				/* keep trying other mounts */
			}
			// Matched a mount prefix but file not found - stop here
			break;
		}
	}

	// Handle static files - only reached for paths NOT matching S3 mounts
	const static_headers = is_dev ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=31536000, immutable" };

	// A literal backslash in the pathname is a traversal on Windows (join()
	// treats it as a separator, so the startsWith containment check passes
	// while the file is read from outside static_dir). The pathname is not
	// URL-decoded here, so %5c stays literal and only this raw form matters.
	// Paths containing one skip static serving and fall through to the 404.
	const has_backslash = url.pathname.includes("\\");

	if (!has_backslash) {
		try {
			for (const static_dir of static_dirs) {
				const file_path = join(static_dir, url.pathname);
				if (!file_path.startsWith(static_dir)) continue;
				if (await Bun.file(file_path).exists()) {
					return new Response(Bun.file(file_path), { status: 200, headers: static_headers });
				}
			}
		} catch (e) {
			// Continue to route handling if file not found
			console.log("Error rendering static file:", e);
		}
	}

	if (wants_json(req)) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	// Fallback 404 with full locale support
	const ctx = await create_ctx(req as Bun.BunRequest);

	// Load root-level translations for the detected language.
	const lang_translations = translations.get(ctx.locale) ?? {};
	const route_translations = lang_translations.routes ?? {};

	return render("notfound", {
		data: { title: "404 Not Found", ...route_translations },
		status: 404,
		ctx,
	});
}

// ---------------------------------------------------------------------------
// Storage configuration check
// ---------------------------------------------------------------------------

/**
 * Log the active storage configuration (S3 or local filesystem).
 * Exits the process with an error if neither is configured and storage
 * mode is auto-detect (no explicit STORAGE env var).
 */
export function check_storage_config(): void {
	const storage_mode = get_storage_mode();

	if (storage_mode === "s3") {
		if (is_s3_configured()) { console.log("☁️  Storage: S3"); }
	} else if (storage_mode === "local") {
		const local_storage = get_local_storage_dir();
		console.log(`📁 Local storage: ${local_storage}`);
	} else {
		if (!is_s3_configured() && !Bun.env.LOCAL_STORAGE_DIR) {
			console.error("✗ Neither S3 nor LOCAL_STORAGE_DIR is configured. No media storage available.");
			console.error("  Set S3_* env vars for S3, or LOCAL_STORAGE_DIR for local filesystem storage.");
			console.error("  Alternatively, set STORAGE=local or STORAGE=s3 to explicitly pick a backend.");
			process.exit(1);
		}

		if (!is_s3_configured() && Bun.env.LOCAL_STORAGE_DIR) {
			const local_storage = get_local_storage_dir();
			console.log(`📁 Local storage: ${local_storage}`);
		}
	}
}
