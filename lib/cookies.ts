/**
 * Cookie utilities - extracted from lib/helpers.ts
 *
 * Functions for reading and creating HTTP cookies.
 */

import { type BunRequest, Cookie } from "bun";

// Minimal cookie reader for a specific cookie name.
export function get_cookie(req: BunRequest, name: string): string | null {
	const cookieHeader = req.headers.get("Cookie");
	if (!cookieHeader) return null;

	// Split on ';' but be tolerant to whitespace
	const pairs = cookieHeader.split(";");

	for (const pair of pairs) {
		const [rawKey, ...rest] = pair.split("=");
		const key = rawKey?.trim();
		if (!key) continue;
		try {
			if (decodeURIComponent(key) !== name) continue;
		} catch {
			continue; // skip malformed cookie keys
		}
		// value may contain '='; re-join and trim
		const value = rest.join("=").trim();
		try {
			return decodeURIComponent(value);
		} catch {
			return value; // fallback if decode fails
		}
	}

	return null;
}

export function get_cookies_by_prefix(req: BunRequest, prefix: string): Array<{ key: string; value: string; }> {
	const cookie_header = req.headers.get("Cookie");

	if (!cookie_header) return [];

	const pairs = cookie_header.split(";");

	const result: Array<{ key: string; value: string; }> = [];

	for (const pair of pairs) {
		const [raw_key, ...rest] = pair.split("=");

		const key = raw_key?.trim();

		if (!key) continue;

		if (!key.startsWith(prefix)) continue;

		const value_raw = rest.join("=").trim();

		try {
			result.push({ key: decodeURIComponent(key), value: decodeURIComponent(value_raw) });
		} catch {
			result.push({ key, value: value_raw });
		}
	}

	return result;
}

/**
 * Create a simple toast cookie for non-record-update messages (bulk-delete, filters, etc.).
 * Unlike `create_toast_cookie`, this doesn't resolve the session - it's synchronous.
 *
 * @param name  Cookie name (e.g. "toast-bulk-delete").
 * @param data  Toast payload (message, optional type/duration).
 * @param path  Optional cookie path (default "/").
 */
export function get_toast_cookies(req: BunRequest): Array<{ key: string; type: string; message: string; [key: string]: unknown; }> {
	return get_cookies_by_prefix(req, "toast-").flatMap(({ key, value }) => {
		try {
			return [{ key, ...JSON.parse(value) as Record<string, unknown> }];
		} catch {
			return [];
		}
	}) as Array<{ key: string; type: string; message: string; [key: string]: unknown; }>;
}

export function make_toast(name: string, data: { message: string; type?: string; duration?: number; }, path = "/"): Cookie {
	const { message, type = "green", duration = 4000 } = data;
	return new Cookie({ name, value: JSON.stringify({ id: name, message, type, duration }), path });
}

export function create_toast_cookie({ record_id, feature, message = "record_updated", type = "yellow", duration = 2500, user }: {
	record_id: number | string;
	feature: string;
	message?: string;
	type?: string;
	duration?: number;
	// Display name of the acting user - callers pass ctx.user?.display_name.
	// Taking the value (not the request) keeps this module session-free.
	user?: string | null;
}): Cookie {
	const id = `toast-updated-${record_id}`;

	return new Cookie({
		name: id,
		value: JSON.stringify({
			id: `toast-updated-${record_id}`,
			record_id,
			feature,
			message,
			type,
			duration,
			user: user || undefined,
		}),
	});
}
