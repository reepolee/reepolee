/**
 * Rate Limits - admin endpoint extracted from server.ts
 *
 * GET /__rate-limits - shows current rate limit counters per scope.
 * POST /__reset-rate-limits - deletes all rl:* keys from Redis.
 */

import { get_rate_limit_status, reset_rate_limits } from "$lib/middleware";

import { require_admin_auth } from "./require_admin_auth";

type RateLimitEntry = { identity: string; window: number; count: number; ttl: number; };

type RateLimitStatus = {
	scopes: Record<string, {
		limit: number;
		window_s: number;
		unique_identities: number;
		entries: RateLimitEntry[];
	}>;
	total_keys: number;
};

type RateLimitSummary = {
	scopes: Record<string, {
		limit: number;
		window_s: number;
		unique_identities: number;
		active_windows: number;
		total_requests: number;
	}>;
	total_keys: number;
};

export function summarize_rate_limit_status(status: RateLimitStatus): RateLimitSummary {
	const scopes: RateLimitSummary["scopes"] = {};

	for (const [scope, scope_status] of Object.entries(status.scopes)) {
		const total_requests = scope_status.entries.reduce((total, entry) => total + entry.count, 0);
		scopes[scope] = {
			limit: scope_status.limit,
			window_s: scope_status.window_s,
			unique_identities: scope_status.unique_identities,
			active_windows: scope_status.entries.length,
			total_requests,
		};
	}

	return { scopes, total_keys: status.total_keys };
}

/**
 * Handle GET /__rate-limits - return current rate limit status as JSON.
 */
export async function handle_rate_limits_get(req: Request): Promise<Response> {
	const auth = require_admin_auth(req, "rate-limit");
	if (!auth.ok) return auth.response;

	try {
		const status = await get_rate_limit_status();
		const summary = summarize_rate_limit_status(status);
		return Response.json(summary, null, 2, { status: 200 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 503 });
	}
}

/**
 * Handle POST /__reset-rate-limits - reset all rate limit counters.
 */
export async function handle_rate_limits_reset(req: Request): Promise<Response> {
	const auth = require_admin_auth(req, "rate-limit");
	if (!auth.ok) return auth.response;

	try {
		const result = await reset_rate_limits();
		console.log(`[rate-limit] Reset by ${auth.caller}: ${result.deleted} key(s) deleted`);
		return Response.json(result, { status: 200 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[rate-limit] Reset failed for ${auth.caller}: ${msg}`);
		return Response.json({ error: msg }, { status: 503 });
	}
}
