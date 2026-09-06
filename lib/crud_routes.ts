/**
 * CRUD route plumbing - shared helpers for the per-feature handler files.
 *
 * Both the hand-written system routes (users, modules, global_scopes, images,
 * translations) and the generated CRUD handlers use the same mechanics:
 * feature-scoped paths, referer-based redirect targets, and the bulk-remove
 * endpoint shape. This module is their single implementation.
 */

import { cache } from "$lib/cache";
import { make_toast } from "$lib/cookies";
import { format_bulk_archive_message, format_bulk_delete_message } from "$lib/format";
import { notify_updates } from "$lib/livereload";
import { sql_log } from "$lib/logger";
import type { RequestContext } from "$lib/request_context";
import type { BunRequest } from "bun";

// ---------------------------------------------------------------------------
// Feature paths
// ---------------------------------------------------------------------------

/**
 * Build the canonical path helpers for a feature mounted under a route prefix.
 *
 * feature_paths("/system", "users") ->
 *   base_path()        "/system/users"
 *   entity_path(5)     "/system/users/5/edit"
 *   entity_path()      "/system/users"
 */
export function feature_paths(route_prefix: string, feature: string): {
	base_path: () => string;
	entity_path: (id?: number | string) => string;
} {
	const base = route_prefix ? `${route_prefix}/${feature}` : `/${feature}`;
	return {
		base_path: () => base,
		entity_path: (id?: number | string) => (id ? `${base}/${id}/edit` : base),
	};
}

// ---------------------------------------------------------------------------
// Referer-based redirect target
// ---------------------------------------------------------------------------

/**
 * Whether a form-supplied return URL is a usable "save & close" target: the
 * feature's own list path, optionally carrying the query string that holds
 * filters, sort and pagination.
 *
 * An entity page is not one. The return URL is captured from document.referrer,
 * and any flow that reloads the edit page - a plain save, or copying a value
 * between locales - makes the edit page its own referrer. A substring test
 * against the base path accepts that and sends "save & close" straight back
 * into the form the user asked to leave.
 */
export function is_list_return_url(return_url: string | null | undefined, base_path: string): boolean {
	if (!return_url) return false;
	const query_start = return_url.indexOf("?");
	const path = query_start === -1 ? return_url : return_url.slice(0, query_start);
	return path === base_path || path === `${base_path}/`;
}

/**
 * Derive a post-save redirect target from the Referer header: the previous
 * list URL (with its query string) when the request came from within the
 * feature's own pages, excluding edit forms. Null when no usable referer.
 */
export function redirect_from_referer(req: BunRequest, base_path: string): string | null {
	const referer = req.headers.get("referer");
	if (!referer) return null;
	try {
		const url = new URL(referer);
		const path = url.pathname + url.search;
		if (path.includes(base_path) && !path.includes("/edit")) return path;
	} catch (e) {
		console.warn("Invalid referer URL:", referer, e);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Bulk remove (archive for archivable tables, hard delete otherwise)
// ---------------------------------------------------------------------------

export interface BulkRemoveOptions {
	/** Feature name for sql_log entries (e.g. "users"). */
	feature: string;
	/** Table name for cache invalidation. */
	table_name: string;
	/** CRUD route the removed records belong to (e.g. "/users"). Used as the
	 * `route` in the ws "updates" notification, so index pages only react to
	 * removals of rows they actually list. */
	route?: string;
	/** Remove one record by its (stringified) id; true when a row was removed. */
	remove_one: (id: string) => Promise<boolean>;
	/** Label used in fallback messages when translation keys are missing. */
	label?: string;
	/** What `remove_one` actually does to the row. Archivable tables set
	 * "archive", which switches the result message and the audit log verb -
	 * telling the user "3 records removed" when the rows are still there would
	 * be a lie. Defaults to "delete" so non-archivable callers are unaffected. */
	mode?: "delete" | "archive";
}

/**
 * The standard bulk-remove endpoint body: parse ids from the JSON payload,
 * remove each record, invalidate the feature's cache, and answer with a JSON
 * summary plus a toast cookie carrying the localized result message.
 *
 * Removals run sequentially so FK-constraint failures surface per-record
 * instead of aborting the whole batch.
 */
export async function run_bulk_remove(req: BunRequest, ctx: RequestContext, opts: BulkRemoveOptions): Promise<Response> {
	const { feature, table_name, remove_one, label = "record", mode = "delete" } = opts;
	const is_archive = mode === "archive";
	const msg = ctx.translations.messages ?? {};
	const locale = ctx.locale || "en-us";

	try {
		const body = (await req.json()) as Record<string, any>;
		const ids: (number | string)[] = body.ids || [];

		if (!Array.isArray(ids) || ids.length === 0) {
			const no_ids_message = is_archive ? msg.bulk_archive_no_ids : msg.bulk_delete_no_ids;
			return Response.json({ error: no_ids_message || "No records selected." }, { status: 400 });
		}

		let removed_count = 0;
		let error_count = 0;

		for (const id of ids) {
			try {
				const removed = await remove_one(String(id));
				if (removed) {
					sql_log({ s: is_archive ? "Archive" : "Delete", t: feature, id: String(id) }, ctx.user?.username);
					notify_updates({ route: opts.route ?? `/${feature}`, action: "deleted", column: "id", value: String(id), description: `${ctx.user?.display_name || ctx.user?.username || "Someone"} deleted the record` });
					removed_count++;
				} else {
					error_count++;
				}
			} catch (err) {
				console.error(`⚠️  Bulk remove error for ID ${id}:`, err);
				error_count++;
			}
		}

		await cache.invalidate(table_name);

		const message = is_archive
			? format_bulk_archive_message(msg, removed_count, error_count, label, locale)
			: format_bulk_delete_message(msg, removed_count, error_count, label, locale);

		// Set toast cookie so the message survives page reload
		const toast_type = error_count > 0 && removed_count === 0 ? "red" : "green";
		const toast_cookie = make_toast("toast-bulk-remove", { message, type: toast_type, duration: 4000 });

		return Response.json({ removed: removed_count, errors: error_count, message }, { headers: { "Set-Cookie": toast_cookie.toString() } });
	} catch (err) {
		console.error("⚠️  Bulk remove failed:", err);
		const failed_message = is_archive ? msg.bulk_archive_failed : msg.bulk_delete_failed;
		return Response.json({ error: failed_message || (is_archive ? "Bulk archive failed." : "Bulk delete failed.") }, { status: 500 });
	}
}

// ---------------------------------------------------------------------------
// Field-list helpers - build record/error shapes from one field-name list
// ---------------------------------------------------------------------------

/** { name: "", email: "", ... } - empty-string map for form record/errors. */
export function empty_strings(field_names: readonly string[]): Record<string, string> { return Object.fromEntries(field_names.map((name) => [name, ""])); }

/** Pick trimmed form params for the given fields ("" when absent). */
export function pick_form_params(params: URLSearchParams, field_names: readonly string[]): Record<string, string> {
	return Object.fromEntries(field_names.map((name) => [name, params.get(name)?.trim() || ""]));
}

/** Pick fields from a parsed JSON body ("" when absent). */
export function pick_body_fields(body: Record<string, any>, field_names: readonly string[]): Record<string, string> {
	return Object.fromEntries(field_names.map((name) => [name, body[name] || ""]));
}
