/**
 * Rate Limit Middleware - Sliding Window Counter
 *
 * Scalability:
 * - Redis keys per identity per scope: 2 (current + previous window)
 * - TTL on each key: 2 × window_s (auto-cleanup)
 * - Redis ops per request: 2–3 (incr, expire if first, get)
 * - No DB queries, no in-memory state
 */

import { rate_limit_rules, type RateLimitRule, type RateLimitScope } from "$config/rate_limit";
import { get_session_id_from_request } from "$lib/session";
import type { BunRequest } from "bun";

import { resolve_rate_limit_store } from "./rate_limit_store";
import type { Middleware } from "./types";

// ---------------------------------------------------------------------------
// Store contract - the seam that lets Redis or SQL back the limiter.
// Method names describe the KV contract, not the backend.
// Injected into check_rate_limit for testability.
// ---------------------------------------------------------------------------

export interface RateLimitStore {
	incr: (key: string) => Promise<number>;
	expire: (key: string, seconds: number) => Promise<void>;
	get: (key: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

// How the deployment establishes a real client IP for anonymous traffic:
//   "cloudflare" - Cloudflare is the only path to the origin; read CF-Connecting-IP.
//   "direct"     - no proxy in front; read the socket peer address via requestIP().
// Production accepts only these two. Any other value (including unset) leaves
// anonymous traffic in a single shared bucket, so the guard rejects it.
const TRUSTED_PROXY_MODES = ["cloudflare", "direct"];

// Only trust client-supplied forwarding headers when explicitly running behind
// a trusted proxy. Otherwise anyone can spoof X-Forwarded-For to dodge the
// IP-keyed limits (e.g. the login brute-force bucket).
function trusted_proxy(): string { return Bun.env.TRUST_PROXY?.trim().toLowerCase() || ""; }

/**
 * Socket peer address for the request, or "" when it cannot be determined.
 *
 * Reads the server handle off globalThis - the same one bootstrap.ts stores at
 * startup. requestIP() lives on Bun.Server, not on the request, and threading a
 * server parameter through the whole Middleware signature would touch every
 * middleware for one caller's benefit.
 *
 * Only meaningful with TRUST_PROXY=direct: behind any proxy this returns the
 * proxy's address, which would collapse all traffic into one bucket.
 */
function socket_ip(req: BunRequest): string {
	const server = globalThis.__reepolee_server as Bun.Server | undefined;
	if (!server) return "";

	const addr = server.requestIP(req);
	const address = addr?.address;
	return address ? address.trim() : "";
}

function is_production(): boolean {
	const argv = process.argv;
	return argv.includes("--prod") && !argv.includes("--test") && !argv.includes("--agent");
}

/**
 * Extract a stable client identity from the request.
 * Priority: session cookie (sid) -> IP.
 *
 * Cloudflare's visitor-IP header is used only when the deployment explicitly
 * declares Cloudflare as the trusted proxy and the origin firewall blocks
 * direct traffic. Other forwarding headers are always untrusted.
 *
 * Under TRUST_PROXY=direct the socket peer address is used instead. That value
 * comes from the kernel rather than the client, so it cannot be spoofed by a
 * header - but it is only the real client on a direct-to-origin deployment.
 * Behind a proxy every request would report the proxy's address, which is why
 * this mode has to be opted into rather than inferred.
 *
 * With no trusted proxy configured, anonymous callers collapse into a single
 * shared bucket ("ip:untrusted-proxy") - a deliberate fail-closed default. It
 * throttles all anonymous traffic together rather than silently trusting a
 * spoofable header.
 */
function extract_identity(req: BunRequest): string {
	const session_id = get_session_id_from_request(req);
	if (session_id) { return `sid:${session_id}`; }

	const proxy_mode = trusted_proxy();

	if (proxy_mode === "cloudflare") {
		const client_ip = req.headers.get("cf-connecting-ip")?.trim();
		return `ip:${client_ip || "cloudflare-missing"}`;
	}

	if (proxy_mode === "direct") {
		const client_ip = socket_ip(req);
		return `ip:${client_ip || "direct-missing"}`;
	}

	return "ip:untrusted-proxy";
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the rate limit scope from the request path + method.
 * Returns null for safe methods (GET/HEAD/OPTIONS) - no rate limit.
 *
 * Priority order:
 * 1. Validation endpoints (posts ending in /validate) - loose validation tier
 * 2. Sensitive auth endpoints (exact path match)
 * 3. Auth prefixes (/register/*) - prefix match
 * 4. Everything else -> global safety net
 */
function resolve_scope(pathname: string, method: string): { scope: RateLimitScope; rule: RateLimitRule; } | null {
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") { return null; }

	// Validate endpoints have their own tier (30/60s) regardless of parent route
	if (pathname.endsWith("/validate")) return {
		scope: "validation",
		rule: rate_limit_rules.validation,
	};

	// Specific sensitive endpoints (exact match)
	if (pathname === "/login") return { scope: "login", rule: rate_limit_rules.login };
	if (pathname === "/password") return { scope: "password", rule: rate_limit_rules.password };
	if (pathname === "/invite") return { scope: "invite", rule: rate_limit_rules.invite };

	// Prefix-based matching
	if (pathname.startsWith("/register")) return {
		scope: "register",
		rule: rate_limit_rules.register,
	};

	// Everything else state-changing -> global safety net
	return { scope: "global", rule: rate_limit_rules.global };
}

// ---------------------------------------------------------------------------
// 429 response
// ---------------------------------------------------------------------------

function rate_limited_response(retry_after: number, rule: RateLimitRule, reset_time: number, req: BunRequest): Response {
	const accept = req.headers.get("accept") || "";
	const wants_json = accept.includes("application/json") || accept.includes("text/json");

	const headers = new Headers({
		"Retry-After": String(retry_after),
		"X-RateLimit-Limit": String(rule.max),
		"X-RateLimit-Remaining": "0",
		"X-RateLimit-Reset": String(reset_time),
	});

	if (wants_json) {
		headers.set("Content-Type", "application/json");
		return new Response(JSON.stringify({ error: "Too Many Requests", retry_after }), { status: 429, headers });
	}

	// Simple inline HTML - no template engine dependency so the middleware
	// stays lightweight and can run as the first middleware in the chain.
	const html = String.raw;
	const html_page = html`<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Too Many Requests</title>
				<link rel="stylesheet" href="/app.css" />
			</head>
			<body class="grid min-h-screen min-w-screen place-items-center p-12">
				<main id="main">
					<h1 style="font-size: 4rem; margin: 0; color: #b40000;">429</h1>
					<h2>Too Many Requests</h2>
					<p>You have sent too many requests. Please wait ${retry_after} seconds before trying again.</p>
					<a href="/"><b>Go Home</b></a>
				</main>
			</body>
		</html>`;

	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(html_page, { status: 429, headers });
}

// ---------------------------------------------------------------------------
// Sliding Window Counter
// ---------------------------------------------------------------------------

/**
 * Check a single scope's rate limit using the sliding window counter algorithm.
 *
 * Algorithm:
 * estimate = prev_window_count × weight + current_window_count
 * where weight = elapsed_seconds_in_current_window / window_size
 *
 * @param store - Rate limit store, Redis- or SQL-backed (injected for testability)
 */
async function check_rate_limit(scope: string, identity: string, rule: RateLimitRule, store: RateLimitStore = resolve_rate_limit_store()): Promise<{ allowed: boolean; retry_after: number; reset_time: number; remaining: number; }> {
	const now = Math.floor(Date.now() / 1000);
	const window_s = rule.window_s;
	const current_window = Math.floor(now / window_s) * window_s;
	const prev_window = current_window - window_s;
	const elapsed = now - current_window;
	const weight = elapsed / window_s;

	const current_key = `rl:${scope}:${identity}:${current_window}`;
	const prev_key = `rl:${scope}:${identity}:${prev_window}`;

	// Increment current window counter (atomic)
	const current_count = await store.incr(current_key);

	// Set expiry on first increment in this window - double window for safety
	if (current_count === 1) { await store.expire(current_key, window_s * 2); }

	// Get previous window count (may have expired)
	const prev_raw = await store.get(prev_key);
	const prev_count = Number(prev_raw || 0);

	// Sliding window estimate
	const estimate = prev_count * weight + current_count;

	const reset_time = current_window + window_s;
	const remaining = Math.max(0, rule.max - Math.ceil(estimate));

	if (Math.ceil(estimate) > rule.max) {
		const retry_after = reset_time - now;
		return { allowed: false, retry_after, reset_time, remaining: 0 };
	}

	return { allowed: true, retry_after: 0, reset_time, remaining };
}

// ---------------------------------------------------------------------------
// Admin: Reset all rate limit counters
// ---------------------------------------------------------------------------

/**
 * Delete all rate limit counters from whichever store backs the limiter.
 * Returns the count of deleted keys.
 */
export async function reset_rate_limits(): Promise<{ deleted: number; }> {
	const store = resolve_rate_limit_store();
	const deleted = await store.reset_all();
	return { deleted };
}

// ---------------------------------------------------------------------------
// Admin: Get rate limit status / snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot of all current rate limit counters in whichever store backs the limiter.
 * Groups by scope with counts, TTLs, and unique identities per scope.
 */
export async function get_rate_limit_status(): Promise<{
	scopes: Record<string, { limit: number; window_s: number; unique_identities: number; entries: Array<{ identity: string; window: number; count: number; ttl: number; }>; }>;
	total_keys: number;
}> {
	const store = resolve_rate_limit_store();
	const counters = await store.list_all();
	if (!counters.length) { return { scopes: {}, total_keys: 0 }; }

	// Parse keys and group by scope
	// Key format: rl:{scope}:{identity}:{window}
	const scopes: Record<string, { limit: number; window_s: number; unique_identities: number; entries: Array<{ identity: string; window: number; count: number; ttl: number; }>; }> = {};

	const seen_identities = new Map();

	for (const counter of counters) {
		const key = counter.key;
		const parts = key.split(":");
		// parts[0]="rl", parts[1]={scope}, parts[2..-2]={identity} (may contain colons e.g. "ip:1.2.3.4"), parts[-1]={window}
		if (parts.length < 4) continue;

		const scope = parts[1];
		// Reconstruct identity: parts[2..-2] joined by ":"
		const identity = parts.slice(2, -1).join(":");
		const window = parseInt(parts[parts.length - 1], 10);
		const count = counter.count;
		const ttl = counter.ttl;

		if (!scopes[scope]) {
			const rule = rate_limit_rules[scope as keyof typeof rate_limit_rules];
			scopes[scope] = {
				limit: rule?.max ?? 0,
				window_s: rule?.window_s ?? 60,
				unique_identities: 0,
				entries: [],
			};
		}

		scopes[scope].entries.push({ identity, window, count, ttl });

		if (!seen_identities.has(scope)) seen_identities.set(scope, new Set());
		seen_identities.get(scope)?.add(identity);
	}

	// Sort entries by count descending within each scope
	for (const scope of Object.keys(scopes)) {
		scopes[scope].entries.sort((a, b) => b.count - a.count);
		scopes[scope].unique_identities = seen_identities.get(scope)?.size ?? 0;
	}

	return { scopes, total_keys: keys.length };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { check_rate_limit, extract_identity, rate_limited_response, resolve_scope };

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Rate limiting middleware using the sliding window counter algorithm.
 *
 * - Guarded by `RATE_LIMITING=true` env var - rate limiting is disabled by default
 * - Only state-changing methods (POST/PUT/PATCH/DELETE) are rate limited
 * - GET/HEAD/OPTIONS pass through unmodified
 * - Uses hybrid identity: session cookie (sid) for authenticated, IP for anonymous
 * - Falls back to IP when no session cookie is present
 * - Returns 429 with Retry-After header when limit exceeded
 * - Fails loud at factory time: process.exit(1) if no store can be resolved
 * - No try/catch around store ops - errors propagate naturally as unhandled rejections
 *
 * The store is resolved by config: Redis when `REDIS_URL` is set, SQL otherwise.
 * A Redis-free install is a supported production configuration - there is no
 * silent fallback to a pass-through limiter either way.
 */
export function rate_limit_mw(store?: RateLimitStore): Middleware {
	const rate_limiting = Bun.env.RATE_LIMITING?.trim().toLowerCase();

	if (is_production()) {
		if (rate_limiting !== "true") {
			console.error("\u001b[31m✗ Production requires RATE_LIMITING=true.\u001b[0m");
			process.exit(1);
		}
		if (!TRUSTED_PROXY_MODES.includes(trusted_proxy())) {
			console.error("\u001b[31m✗ Production requires TRUST_PROXY=cloudflare (Cloudflare-only origin firewall) or TRUST_PROXY=direct (no proxy in front).\u001b[0m");
			process.exit(1);
		}
	}

	if (rate_limiting === "true") {
		const rl = store ?? resolve_rate_limit_store();

		if (!rl) {
			console.error("\u001b[31m✗ RATE_LIMITING=true requires a rate limit store (REDIS_URL or a SQL CONNECTION_STRING)\u001b[0m");
			process.exit(1);
		}

		return async (req: BunRequest, next) => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const method = req.method.toUpperCase();

			// Resolve scope - null means no rate limiting for this method
			const resolved = resolve_scope(pathname, method);
			if (!resolved) { return next(req); }

			const identity = extract_identity(req);

			const result = await check_rate_limit(resolved.scope, identity, resolved.rule, rl);

			if (!result.allowed) { return rate_limited_response(result.retry_after, resolved.rule, result.reset_time, req); }

			// Within limit - pass through
			return next(req);
		};
	}

	// RATE_LIMITING disabled or not set - pass through. Warn loudly in
	// production only, where an unset flag means login/password brute-force
	// protection is silently off; dev/test/agent stay quiet to avoid noise.
	const argv = process.argv;
	if (argv.includes("--prod") && !argv.includes("--test") && !argv.includes("--agent")) {
		console.warn(
			"\u001b[33m⚠ RATE_LIMITING is not enabled - brute-force protection on /login, /password, /register is OFF. Set RATE_LIMITING=true (requires REDIS_URL).\u001b[0m"
		);
	}

	return (_req: BunRequest, next) => next(_req);
}
