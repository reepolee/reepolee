/**
 * Generic upload endpoints - table-agnostic image/file upload handlers that
 * both the main app server and the reeman server expose, so CRUD form fields
 * (`<image-upload>` / `<file-upload>`) can process + store media without
 * writing to reeman's admin `images` / `files` tables.
 *
 * M2/M3 of PLAN_image_file_manager_extraction.md. reeman's own DB-coupled
 * handlers (`/images/process`, `/images/save`, `/files/save`) stay unchanged
 * for the sysadmin admin UI.
 *
 * These handlers are wired at the fetch-handler level (before route matching),
 * so they do not pass through `wrap_all_routes` and its `csrf_mw`. Each
 * handler therefore validates the CSRF token explicitly via
 * `require_valid_csrf()`, imported from the middleware so both paths share one
 * implementation - this file used to carry a second copy of the check, which
 * would have silently drifted the moment the token scheme changed.
 */

import { post_file_save_upload } from "$lib/file_processor/upload_routes";
import { post_image_process_upload, post_image_save_upload } from "$lib/image_processor/upload_routes";
import { require_valid_csrf } from "$lib/middleware/csrf";
import type { BunRequest } from "bun";

export { require_valid_csrf };

/**
 * Handle the generic upload endpoints. Returns a Response when the URL
 * matches, or null to continue normal routing.
 */
export async function handle_generic_upload_endpoints(req: Request, url: URL): Promise<Response | null> {
	const is_upload = url.pathname === "/upload/image/process" || url.pathname === "/upload/image/save" || url.pathname === "/upload/file/save";
	if (!is_upload) return null;

	const bun_req = req as BunRequest;

	// These endpoints bypass wrap_all_routes / csrf_mw (fetch-handler level),
	// so validate the token explicitly - the same check csrf_mw performs.
	if (bun_req.method === "POST") {
		const csrf_guard = await require_valid_csrf(bun_req);
		if (csrf_guard) return csrf_guard;
	}

	if (url.pathname === "/upload/image/process" && bun_req.method === "POST") { return post_image_process_upload(bun_req); }
	if (url.pathname === "/upload/image/save" && bun_req.method === "POST") { return post_image_save_upload(bun_req); }
	if (url.pathname === "/upload/file/save" && bun_req.method === "POST") { return post_file_save_upload(bun_req); }
	return null;
}
