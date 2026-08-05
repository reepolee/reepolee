/**
 * Rate limit configuration.
 *
 * Each rule defines a maximum number of requests within a sliding window.
 * Scopes are resolved by path prefix - see resolve_scope() in the middleware.
 */

export interface RateLimitRule {
	// Maximum requests allowed in the window.
	max: number;
	// Window duration in seconds.
	window_s: number;
}

export type RateLimitScope = "global" | "login" | "register" | "password" | "invite" | "validation";

// Per-scope rate limit rules.
export const rate_limit_rules: Record<RateLimitScope, RateLimitRule> = {
	// Global safety net - all state-changing requests not matching a specific scope.
	global: { max: 300, window_s: 60 },

	// POST /login
	login: { max: 5, window_s: 60 },

	// POST /register/*
	register: { max: 3, window_s: 60 },

	// POST /password
	password: { max: 5, window_s: 60 },

	// POST /invite
	invite: { max: 10, window_s: 60 },

	// POST /validate (client-side validation endpoints)
	validation: { max: 30, window_s: 60 },
};
