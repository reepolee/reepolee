/**
 * CRUD route plumbing - shared helpers for the per-feature handler files.
 *
 * Both the hand-written system routes (users, modules, global_scopes, images,
 * translations) and the generated CRUD handlers use the same mechanics:
 * feature-scoped paths, referer-based redirect targets, and the bulk-delete
 * endpoint shape. This module is their single implementation.
 */

import { cache } from "$lib/cache";
import { make_toast } from "$lib/cookies";
import { format_bulk_delete_message } from "$lib/format";
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
// Bulk delete
// ---------------------------------------------------------------------------

export interface BulkDeleteOptions {
	/** Feature name for sql_log entries (e.g. "users"). */
	feature: string;
	/** Table name for cache invalidation. */
	table_name: string;
	/** Delete one record by its (stringified) id; true when a row was deleted. */
	delete_one: (id: string) => Promise<boolean>;
	/** Label used in fallback messages when translation keys are missing. */
	label?: string;
}

/**
 * The standard bulk-delete endpoint body: parse ids from the JSON payload,
 * delete each record, invalidate the feature's cache, and answer with a JSON
 * summary plus a toast cookie carrying the localized result message.
 *
 * Deletes run sequentially so FK-constraint failures surface per-record
 * instead of aborting the whole batch.
 */
export async function run_bulk_delete(req: BunRequest, ctx: RequestContext, opts: BulkDeleteOptions): Promise<Response> {
	const { feature, table_name, delete_one, label = "record" } = opts;
	const msg = ctx.translations.messages ?? {};
	const locale = ctx.locale || "en-US";

	try {
		const body = (await req.json()) as Record<string, any>;
		const ids: (number | string)[] = body.ids || [];

		if (!Array.isArray(ids) || ids.length === 0) {
			return Response.json({ error: msg.bulk_delete_no_ids || "No records selected." }, { status: 400 });
		}

		let deleted_count = 0;
		let error_count = 0;

		for (const id of ids) {
			try {
				const deleted = await delete_one(String(id));
				if (deleted) {
					sql_log({ s: "Delete", t: feature, id: String(id) }, ctx.user?.username);
					deleted_count++;
				} else {
					error_count++;
				}
			} catch (err) {
				console.error(`⚠️  Bulk delete error for ID ${id}:`, err);
				error_count++;
			}
		}

		await cache.invalidate(table_name);

		const message = format_bulk_delete_message(msg, deleted_count, error_count, label, locale);

		// Set toast cookie so the message survives page reload
		const toast_type = error_count > 0 && deleted_count === 0 ? "red" : "green";
		const toast_cookie = make_toast("toast-bulk-delete", { message, type: toast_type, duration: 4000 });

		return Response.json({ deleted: deleted_count, errors: error_count, message }, { headers: { "Set-Cookie": toast_cookie.toString() } });
	} catch (err) {
		console.error("⚠️  Bulk delete failed:", err);
		return Response.json({ error: msg.bulk_delete_failed || "Bulk delete failed." }, { status: 500 });
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
