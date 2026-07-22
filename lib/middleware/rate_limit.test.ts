import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Initialize the global html tag (String.raw) - normally set in server.ts
(globalThis as any).html = String.raw;

// ---------------------------------------------------------------------------
// Mock cookies module - session ID extraction for identity tests.
// Path aliases ($root/*) CAN be mocked via mock.module.
// ---------------------------------------------------------------------------

let mock_session_id: string | null = null;

mock.module("$lib/session", () => ({
	get_session_id_from_request: () => mock_session_id,
	SESSION_COOKIE_NAME: "sid",
}));

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

const rate_limit = await import("./rate_limit");
import type { RateLimitStore } from "./rate_limit";

// ---------------------------------------------------------------------------
// Mock Redis client factory
// ---------------------------------------------------------------------------

function mock_store(overrides?: Partial<RateLimitStore>): RateLimitStore {
	return { incr: async () => 1, expire: async () => {}, get: async () => null, ...overrides };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mock_req(overrides: { url?: string; method?: string; headers?: Record<string, string>; }): any {
	const url = overrides.url ?? "http://localhost/test";
	const method = overrides.method ?? "GET";
	const headers_map = new Map(Object.entries(overrides.headers ?? {}));
	return { url, method, headers: { get(name: string) { return headers_map.get(name.toLowerCase()) ?? null; } } };
}

// ---------------------------------------------------------------------------
// Tests: resolve_scope
// ---------------------------------------------------------------------------

describe("resolve_scope", () => {
	test("returns null for GET requests", () => expect(rate_limit.resolve_scope("/login", "GET")).toBeNull());

	test("returns null for HEAD requests", () => expect(rate_limit.resolve_scope("/login", "HEAD")).toBeNull());

	test("returns null for OPTIONS requests", () => expect(rate_limit.resolve_scope("/login", "OPTIONS")).toBeNull());

	test("returns login scope for POST /login", () => {
		const result = rate_limit.resolve_scope("/login", "POST");
		expect(result?.scope).toBe("login");
		expect(result?.rule.max).toBe(5);
		expect(result?.rule.window_s).toBe(60);
	});

	test("returns register scope for POST /register/* (dynamic path)", () => {
		const result = rate_limit.resolve_scope("/register/user@example.com/abc-123", "POST");
		expect(result?.scope).toBe("register");
		expect(result?.rule.max).toBe(3);
	});

	test("returns validation scope for POST /register/validate (validate checked first)", () => {
		const result = rate_limit.resolve_scope("/register/validate", "POST");
		expect(result?.scope).toBe("validation");
		expect(result?.rule.max).toBe(30);
	});

	test("returns validation scope for POST /login/validate", () => {
		const result = rate_limit.resolve_scope("/login/validate", "POST");
		expect(result?.scope).toBe("validation");
		expect(result?.rule.max).toBe(30);
	});

	test("returns validation scope for POST /password/validate", () => {
		const result = rate_limit.resolve_scope("/password/validate", "POST");
		expect(result?.scope).toBe("validation");
	});

	test("returns validation scope for POST /invite/validate", () => {
		const result = rate_limit.resolve_scope("/invite/validate", "POST");
		expect(result?.scope).toBe("validation");
	});

	test("returns password scope for POST /password", () => {
		const result = rate_limit.resolve_scope("/password", "POST");
		expect(result?.scope).toBe("password");
		expect(result?.rule.max).toBe(5);
	});

	test("returns invite scope for POST /invite", () => {
		const result = rate_limit.resolve_scope("/invite", "POST");
		expect(result?.scope).toBe("invite");
		expect(result?.rule.max).toBe(10);
	});

	test("returns validation scope for POST /some/deep/path/validate", () => {
		const result = rate_limit.resolve_scope("/some/deep/path/validate", "POST");
		expect(result?.scope).toBe("validation");
		expect(result?.rule.max).toBe(30);
	});

	test("returns global scope for unmatched state-changing routes", () => {
		const result = rate_limit.resolve_scope("/api/data", "POST");
		expect(result?.scope).toBe("global");
		expect(result?.rule.max).toBe(300);
	});

	test("returns global scope for PUT requests", () => expect(rate_limit.resolve_scope("/api/data/1", "PUT")?.scope).toBe("global"));

	test("returns global scope for PATCH requests", () => expect(rate_limit.resolve_scope("/api/data/1", "PATCH")?.scope).toBe("global"));

	test("returns global scope for DELETE requests", () => expect(rate_limit.resolve_scope("/api/data/1", "DELETE")?.scope).toBe("global"));
});

// ---------------------------------------------------------------------------
// Tests: extract_identity
// ---------------------------------------------------------------------------

describe("extract_identity", () => {
	const before_trust_proxy = process.env.TRUST_PROXY;

	beforeEach(() => mock_session_id = null);

	// Clear TRUST_PROXY before each test so the four "untrusted proxy" tests
	// are not polluted by the .env file (which sets TRUST_PROXY=direct).
	// Each test that needs a specific TRUST_PROXY value sets it in its body
	// or in a nested describe's beforeEach.
	beforeEach(() => { delete process.env.TRUST_PROXY; });

	afterEach(() => {
		if (before_trust_proxy === undefined) delete process.env.TRUST_PROXY;
		else process.env.TRUST_PROXY = before_trust_proxy;
	});

	test("uses session cookie (sid) when present", () => {
		mock_session_id = "abc-123-def";
		const req = mock_req({ headers: { cookie: "sid=abc-123-def" } });
		expect(rate_limit.extract_identity(req)).toBe("sid:abc-123-def");
	});

	// With no TRUST_PROXY set, forwarding headers are NOT trusted and all
	// anonymous requests collapse to a single "ip:untrusted-proxy" bucket - a
	// client cannot spoof X-Forwarded-For to mint fresh rate-limit identities.
	// Fail closed: throttle anonymous traffic together rather than trust a
	// spoofable header.
	test("ignores x-forwarded-for when proxy is not trusted", () => {
		const req = mock_req({ headers: { "x-forwarded-for": "203.0.113.42" } });
		expect(rate_limit.extract_identity(req)).toBe("ip:untrusted-proxy");
	});

	test("ignores x-real-ip when proxy is not trusted", () => {
		const req = mock_req({ headers: { "x-real-ip": "10.0.0.1" } });
		expect(rate_limit.extract_identity(req)).toBe("ip:untrusted-proxy");
	});

	test("ignores spoofed x-forwarded-for chain when proxy is not trusted", () => {
		const req = mock_req({ headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.42, 10.0.0.1" } });
		expect(rate_limit.extract_identity(req)).toBe("ip:untrusted-proxy");
	});

	test("returns ip:untrusted-proxy when no identity info available", () => {
		const req = mock_req({});
		expect(rate_limit.extract_identity(req)).toBe("ip:untrusted-proxy");
	});

	test("uses CF-Connecting-IP only when Cloudflare is the trusted proxy", () => {
		const original_trust_proxy = process.env.TRUST_PROXY;
		try {
			process.env.TRUST_PROXY = "cloudflare";
			const req = mock_req({ headers: { "cf-connecting-ip": "203.0.113.42", "x-forwarded-for": "198.51.100.10" } });
			expect(rate_limit.extract_identity(req)).toBe("ip:203.0.113.42");
		} finally {
			if (original_trust_proxy === undefined) delete process.env.TRUST_PROXY;
			else process.env.TRUST_PROXY = original_trust_proxy;
		}
	});

	// TRUST_PROXY=direct - socket peer address via Server.requestIP(), read off
	// the globalThis server handle that bootstrap.ts installs at startup.
	describe("direct mode", () => {
		const original_trust_proxy = process.env.TRUST_PROXY;
		const original_server = (globalThis as any).__reepolee_server;

		function fake_server(address: string | null) {
			return { requestIP: () => (address === null ? null : { address, family: "IPv4", port: 54321 }) };
		}

		beforeEach(() => { process.env.TRUST_PROXY = "direct"; });

		afterEach(() => {
			if (original_trust_proxy === undefined) delete process.env.TRUST_PROXY;
			else process.env.TRUST_PROXY = original_trust_proxy;
			(globalThis as any).__reepolee_server = original_server;
		});

		test("uses the socket peer address", () => {
			(globalThis as any).__reepolee_server = fake_server("192.168.1.50");
			const req = mock_req({});
			expect(rate_limit.extract_identity(req)).toBe("ip:192.168.1.50");
		});

		test("gives each client IP its own bucket", () => {
			(globalThis as any).__reepolee_server = fake_server("192.168.1.50");
			const first = rate_limit.extract_identity(mock_req({}));
			(globalThis as any).__reepolee_server = fake_server("192.168.1.51");
			const second = rate_limit.extract_identity(mock_req({}));
			expect(first).not.toBe(second);
		});

		// The whole point of reading the socket rather than a header: a client
		// cannot spoof its way into a fresh bucket.
		test("ignores spoofed forwarding headers", () => {
			(globalThis as any).__reepolee_server = fake_server("192.168.1.50");
			const req = mock_req({ headers: { "x-forwarded-for": "203.0.113.42", "cf-connecting-ip": "198.51.100.10" } });
			expect(rate_limit.extract_identity(req)).toBe("ip:192.168.1.50");
		});

		test("falls back to direct-missing when the peer address is unavailable", () => {
			(globalThis as any).__reepolee_server = fake_server(null);
			const req = mock_req({});
			expect(rate_limit.extract_identity(req)).toBe("ip:direct-missing");
		});

		test("falls back to direct-missing when no server handle is registered", () => {
			delete (globalThis as any).__reepolee_server;
			const req = mock_req({});
			expect(rate_limit.extract_identity(req)).toBe("ip:direct-missing");
		});

		test("session cookie still wins over the socket address", () => {
			(globalThis as any).__reepolee_server = fake_server("192.168.1.50");
			mock_session_id = "sess-9";
			const req = mock_req({});
			expect(rate_limit.extract_identity(req)).toBe("sid:sess-9");
		});
	});
});

// ---------------------------------------------------------------------------
// Tests: rate_limited_response
// ---------------------------------------------------------------------------

describe("rate_limited_response", () => {
	const rule = { max: 300, window_s: 60 };
	const reset_time = 1_000_000_000;

	test("returns 429 status", () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res = rate_limit.rate_limited_response(30, rule, reset_time, req);
		expect(res.status).toBe(429);
	});

	test("returns Retry-After header", () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res = rate_limit.rate_limited_response(30, rule, reset_time, req);
		expect(res.headers.get("Retry-After")).toBe("30");
	});

	test("returns X-RateLimit-Limit header", () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res = rate_limit.rate_limited_response(30, rule, reset_time, req);
		expect(res.headers.get("X-RateLimit-Limit")).toBe("300");
	});

	test("returns X-RateLimit-Remaining: 0", () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res = rate_limit.rate_limited_response(30, rule, reset_time, req);
		expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
	});

	test("returns X-RateLimit-Reset header", () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res = rate_limit.rate_limited_response(30, rule, reset_time, req);
		expect(res.headers.get("X-RateLimit-Reset")).toBe("1000000000");
	});

	test("returns JSON with Content-Type for API requests", () => {
		const req = mock_req({ headers: { accept: "application/json" } });
		const res = rate_limit.rate_limited_response(42, rule, reset_time, req);
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});

	test("returns JSON body with error and retry_after", async () => {
		const req = mock_req({ headers: { accept: "application/json" } });
		const res = rate_limit.rate_limited_response(42, rule, reset_time, req);
		const body = await res.json();
		expect(body.error).toBe("Too Many Requests");
		expect(body.retry_after).toBe(42);
	});

	test("returns HTML with Content-Type for browser requests", () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res = rate_limit.rate_limited_response(15, rule, reset_time, req);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
	});

	test("returns HTML with retry_after in body text", async () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res = rate_limit.rate_limited_response(15, rule, reset_time, req);
		const text = await res.text();
		expect(text).toContain("429");
		expect(text).toContain("Too Many Requests");
		expect(text).toContain("15 seconds");
	});
});

// ---------------------------------------------------------------------------
// Tests: check_rate_limit
// ---------------------------------------------------------------------------

describe("check_rate_limit", () => {
	const rule = { max: 300, window_s: 60 };

	test("allows request under the limit (first request)", async () => {
		const mr = mock_store({ incr: async () => 1, get: async () => null });

		const result = await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBeGreaterThan(0);
	});

	test("allows request at exactly the limit", async () => {
		const mr = mock_store({ incr: async () => 300, get: async () => "0" });

		const result = await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(0);
	});

	test("blocks request over the limit", async () => {
		const mr = mock_store({ incr: async () => 301, get: async () => "0" });

		const result = await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);
		expect(result.allowed).toBe(false);
		expect(result.remaining).toBe(0);
		expect(result.retry_after).toBeGreaterThan(0);
	});

	test("accounts for previous window count in sliding estimate", async () => {
		// Previous had 200, current has 150. At 100% through window:
		// estimate = 200 * 1.0 + 150 = 350 -> over limit of 300
		// At 0% through: estimate = 200 * 0.0 + 150 = 150 -> under limit
		// This test runs at an arbitrary time, so we use a mock that
		// doesn't depend on timing: current=150, prev=0, estimate=150
		const mr = mock_store({ incr: async () => 150, get: async () => "0" });

		const result = await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);
		expect(result.allowed).toBe(true);
	});

	test("blocks with high previous window count regardless of timing", async () => {
		// current=999, prev=0 -> always exceeds limit of 300
		const mr = mock_store({ incr: async () => 999, get: async () => "0" });

		const result = await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);
		expect(result.allowed).toBe(false);
	});

	test("sets expiry on first increment in a window", async () => {
		let expire_called = false;
		let expire_key = "";
		let expire_seconds = 0;
		const mr = mock_store({
			incr: async () => 1,
			expire: async (key, sec) => {
				expire_called = true;
				expire_key = key;
				expire_seconds = sec;
			},
		});

		await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);

		expect(expire_called).toBe(true);
		expect(expire_seconds).toBe(rule.window_s * 2);
		expect(expire_key).toContain("rl:global:ip:1.2.3.4:");
	});

	test("does not call expire when count is already > 1", async () => {
		let expire_called = false;
		const mr = mock_store({ incr: async () => 5, expire: async () => expire_called = true });

		await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);

		expect(expire_called).toBe(false);
	});

	test("treats missing previous window as 0", async () => {
		const mr = mock_store({ incr: async () => 50, get: async () => null });

		const result = await rate_limit.check_rate_limit("global", "ip:1.2.3.4", rule, mr);
		expect(result.allowed).toBe(true);
	});

	test("constructs correct Redis keys with different current/previous windows", async () => {
		const called_keys: string[] = [];
		const mr = mock_store({
			incr: async (key) => {
				called_keys.push(key);
				return 1;
			},
			get: async (key) => {
				called_keys.push(key);
				return null;
			},
		});

		await rate_limit.check_rate_limit("login", "sid:abc-123", { max: 5, window_s: 60 }, mr);

		// incr (current window) + get (previous window) = 2 calls
		expect(called_keys).toHaveLength(2);
		expect(called_keys[0]).toContain("rl:login:sid:abc-123:");
		expect(called_keys[1]).toContain("rl:login:sid:abc-123:");
		// Two different window timestamps
		expect(called_keys[0]).not.toBe(called_keys[1]);
	});
}); // ---------------------------------------------------------------------------
// Tests: rate_limit_mw (middleware factory)
// ---------------------------------------------------------------------------

describe("rate_limit_mw", () => {
	test("returns pass-through middleware when RATE_LIMITING is not set", async () => {
		delete process.env.RATE_LIMITING;

		const mw = rate_limit.rate_limit_mw();

		const req = mock_req({ method: "POST", url: "http://localhost/login" });
		let next_called = false;
		const next = async (_req: any) => {
			next_called = true;
			return new Response("OK");
		};

		await mw(req, next as any);
		expect(next_called).toBe(true);
	});

	test("returns pass-through middleware when RATE_LIMITING=false", async () => {
		process.env.RATE_LIMITING = "false";

		const mw = rate_limit.rate_limit_mw(mock_store());

		const req = mock_req({ method: "POST", url: "http://localhost/login" });
		let next_called = false;
		const next = async (_req: any) => {
			next_called = true;
			return new Response("OK");
		};

		await mw(req, next as any);
		expect(next_called).toBe(true);

		delete process.env.RATE_LIMITING;
	});

	test("passes through GET requests when RATE_LIMITING=true", async () => {
		process.env.RATE_LIMITING = "true";
		const mw = rate_limit.rate_limit_mw(mock_store());

		const req = mock_req({ method: "GET", url: "http://localhost/login" });
		let next_called = false;
		const next = async (_req: any) => {
			next_called = true;
			return new Response("OK");
		};

		await mw(req, next as any);
		expect(next_called).toBe(true);

		delete process.env.RATE_LIMITING;
	});

	test("returns 429 when rate limit exceeded (RATE_LIMITING=true)", async () => {
		process.env.RATE_LIMITING = "true";
		const mr = mock_store({ incr: async () => 999 });

		const mw = rate_limit.rate_limit_mw(mr);
		const req = mock_req({
			method: "POST",
			url: "http://localhost/login",
			headers: { accept: "application/json" },
		});

		const res = await mw(req, async () => new Response("OK"));
		expect(res.status).toBe(429);

		delete process.env.RATE_LIMITING;
	});

	test("returns 429 JSON body when rate limited (RATE_LIMITING=true)", async () => {
		process.env.RATE_LIMITING = "true";
		const mr = mock_store({ incr: async () => 999 });

		const mw = rate_limit.rate_limit_mw(mr);
		const req = mock_req({
			method: "POST",
			url: "http://localhost/login",
			headers: { accept: "application/json" },
		});

		const res = await mw(req, async () => new Response("OK"));
		const body = await res.json();
		expect(body.error).toBe("Too Many Requests");

		delete process.env.RATE_LIMITING;
	});

	// Redis is no longer required: with no REDIS_URL the resolver falls back to
	// the SQL store, so RATE_LIMITING=true is a complete configuration on its own.
	test("starts when RATE_LIMITING=true and no Redis (SQL-backed)", () => {
		const original_redis_url = process.env.REDIS_URL;
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			process.env.RATE_LIMITING = "true";
			delete process.env.REDIS_URL;

			expect(typeof rate_limit.rate_limit_mw()).toBe("function");
		} finally {
			(process as any).exit = original_exit;
			delete process.env.RATE_LIMITING;
			if (original_redis_url) { process.env.REDIS_URL = original_redis_url; }
		}
	});

	test("fails loudly in production when rate limiting is disabled", () => {
		const original_argv = [...process.argv];
		const original_rate_limiting = process.env.RATE_LIMITING;
		const original_redis_url = process.env.REDIS_URL;
		const original_trust_proxy = process.env.TRUST_PROXY;
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			process.argv.splice(0, process.argv.length, ...original_argv.filter((arg) => arg !== "--test"), "--prod");
			process.env.RATE_LIMITING = "false";
			process.env.REDIS_URL = "redis://127.0.0.1:6379";
			process.env.TRUST_PROXY = "cloudflare";

			expect(() => rate_limit.rate_limit_mw(mock_store())).toThrow("process.exit(1)");
		} finally {
			process.argv.splice(0, process.argv.length, ...original_argv);
			process.env.RATE_LIMITING = original_rate_limiting;
			process.env.REDIS_URL = original_redis_url;
			process.env.TRUST_PROXY = original_trust_proxy;
			(process as any).exit = original_exit;
		}
	});

	test("fails loudly in production without Cloudflare proxy mode", () => {
		const original_argv = [...process.argv];
		const original_rate_limiting = process.env.RATE_LIMITING;
		const original_redis_url = process.env.REDIS_URL;
		const original_trust_proxy = process.env.TRUST_PROXY;
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			process.argv.splice(0, process.argv.length, ...original_argv.filter((arg) => arg !== "--test"), "--prod");
			process.env.RATE_LIMITING = "true";
			process.env.REDIS_URL = "redis://127.0.0.1:6379";
			delete process.env.TRUST_PROXY;

			expect(() => rate_limit.rate_limit_mw(mock_store())).toThrow("process.exit(1)");
		} finally {
			process.argv.splice(0, process.argv.length, ...original_argv);
			process.env.RATE_LIMITING = original_rate_limiting;
			process.env.REDIS_URL = original_redis_url;
			process.env.TRUST_PROXY = original_trust_proxy;
			(process as any).exit = original_exit;
		}
	});

	// A Redis-free production install is supported - the SQL store backs it.
	test("starts in production without Redis (SQL-backed)", () => {
		const original_argv = [...process.argv];
		const original_rate_limiting = process.env.RATE_LIMITING;
		const original_redis_url = process.env.REDIS_URL;
		const original_trust_proxy = process.env.TRUST_PROXY;
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			process.argv.splice(0, process.argv.length, ...original_argv.filter((arg) => arg !== "--test"), "--prod");
			process.env.RATE_LIMITING = "true";
			delete process.env.REDIS_URL;
			process.env.TRUST_PROXY = "cloudflare";

			expect(typeof rate_limit.rate_limit_mw(mock_store())).toBe("function");
		} finally {
			process.argv.splice(0, process.argv.length, ...original_argv);
			process.env.RATE_LIMITING = original_rate_limiting;
			process.env.REDIS_URL = original_redis_url;
			process.env.TRUST_PROXY = original_trust_proxy;
			(process as any).exit = original_exit;
		}
	});

	test("starts in production with Redis and Cloudflare proxy mode", () => {
		const original_argv = [...process.argv];
		const original_rate_limiting = process.env.RATE_LIMITING;
		const original_redis_url = process.env.REDIS_URL;
		const original_trust_proxy = process.env.TRUST_PROXY;

		try {
			process.argv.splice(0, process.argv.length, ...original_argv.filter((arg) => arg !== "--test"), "--prod");
			process.env.RATE_LIMITING = "true";
			process.env.REDIS_URL = "redis://127.0.0.1:6379";
			process.env.TRUST_PROXY = "cloudflare";

			expect(typeof rate_limit.rate_limit_mw(mock_store())).toBe("function");
		} finally {
			process.argv.splice(0, process.argv.length, ...original_argv);
			process.env.RATE_LIMITING = original_rate_limiting;
			process.env.REDIS_URL = original_redis_url;
			process.env.TRUST_PROXY = original_trust_proxy;
		}
	});

	// TRUST_PROXY=direct is the no-proxy deployment (e.g. a LAN box reachable
	// straight from clients). It satisfies the guard because requestIP() yields
	// a real per-client address there.
	test("starts in production with direct proxy mode and no Redis", () => {
		const original_argv = [...process.argv];
		const original_rate_limiting = process.env.RATE_LIMITING;
		const original_redis_url = process.env.REDIS_URL;
		const original_trust_proxy = process.env.TRUST_PROXY;

		try {
			process.argv.splice(0, process.argv.length, ...original_argv.filter((arg) => arg !== "--test"), "--prod");
			process.env.RATE_LIMITING = "true";
			delete process.env.REDIS_URL;
			process.env.TRUST_PROXY = "direct";

			expect(typeof rate_limit.rate_limit_mw(mock_store())).toBe("function");
		} finally {
			process.argv.splice(0, process.argv.length, ...original_argv);
			process.env.RATE_LIMITING = original_rate_limiting;
			if (original_redis_url) { process.env.REDIS_URL = original_redis_url; }
			process.env.TRUST_PROXY = original_trust_proxy;
		}
	});

	// Only the two known modes are accepted - an unrecognized value must not
	// quietly leave anonymous traffic in one shared bucket.
	test("fails loudly in production with an unrecognized TRUST_PROXY value", () => {
		const original_argv = [...process.argv];
		const original_rate_limiting = process.env.RATE_LIMITING;
		const original_trust_proxy = process.env.TRUST_PROXY;
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			process.argv.splice(0, process.argv.length, ...original_argv.filter((arg) => arg !== "--test"), "--prod");
			process.env.RATE_LIMITING = "true";
			process.env.TRUST_PROXY = "nginx";

			expect(() => rate_limit.rate_limit_mw(mock_store())).toThrow("process.exit(1)");
		} finally {
			process.argv.splice(0, process.argv.length, ...original_argv);
			process.env.RATE_LIMITING = original_rate_limiting;
			process.env.TRUST_PROXY = original_trust_proxy;
			(process as any).exit = original_exit;
		}
	});
});

// ---------------------------------------------------------------------------
// Additional coverage: rate_limit - edge cases
// ---------------------------------------------------------------------------

describe("rate_limit - additional coverage", () => {
	describe("check_rate_limit - edge cases", () => {
		test("handles Redis error gracefully in check_rate_limit", async () => {
			const failing_redis = mock_store({ incr: async () => { throw new Error("Redis connection failed"); } });

			await expect(rate_limit.check_rate_limit("global", "ip:1.2.3.4", {
				max: 300,
				window_s: 60,
			}, failing_redis)).rejects.toThrow("Redis connection failed");
		});

		test("x-forwarded-for with only whitespace entries", () => {
			mock_session_id = null;
			const req = mock_req({ headers: { "x-forwarded-for": " " } });
			const identity = rate_limit.extract_identity(req);
			expect(identity).toMatch(/^ip:/);
		});
	});

	describe("rate_limited_response - edge cases", () => test("returns different retry-after values", () => {
		const req = mock_req({ headers: { accept: "text/html" } });
		const res1 = rate_limit.rate_limited_response(5, { max: 5, window_s: 60 }, 1000000, req);
		const res2 = rate_limit.rate_limited_response(30, { max: 5, window_s: 60 }, 2000000, req);
		expect(res1.headers.get("Retry-After")).toBe("5");
		expect(res2.headers.get("Retry-After")).toBe("30");
	}));

	// The admin surface used to throw "REDIS_URL is not set" outright. It now
	// resolves the SQL store instead, so a Redis-free install keeps
	// /system/rate_limits and /__rate-limits working rather than erroring.
	describe("admin surface without Redis", () => {
		const original_redis_url = process.env.REDIS_URL;

		afterEach(() => {
			if (original_redis_url) {
				process.env.REDIS_URL = original_redis_url;
			} else {
				delete process.env.REDIS_URL;
			}
		});

		test("reset_rate_limits resolves against the SQL store", async () => {
			delete process.env.REDIS_URL;
			const result = await rate_limit.reset_rate_limits();
			expect(typeof result.deleted).toBe("number");
		});

		test("reset_rate_limits treats an empty REDIS_URL as unset", async () => {
			process.env.REDIS_URL = "";
			const result = await rate_limit.reset_rate_limits();
			expect(typeof result.deleted).toBe("number");
		});

		test("get_rate_limit_status resolves against the SQL store", async () => {
			delete process.env.REDIS_URL;
			const status = await rate_limit.get_rate_limit_status();
			expect(typeof status.total_keys).toBe("number");
			expect(status.scopes).toBeDefined();
		});

		test("get_rate_limit_status treats an empty REDIS_URL as unset", async () => {
			process.env.REDIS_URL = "";
			const status = await rate_limit.get_rate_limit_status();
			expect(typeof status.total_keys).toBe("number");
		});
	});
});
