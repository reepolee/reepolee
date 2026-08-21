/**
 * Environment variable inventory and presence check.
 *
 * Tightens the `.env` contract so a variable that is missing is visible
 * instead of silently disabling a feature. The known variable set is a stable,
 * hand-maintained inventory (`KNOWN_ENV_VARS`) committed in code - NOT parsed
 * from `.env`/`.env.example` at runtime, so the check keeps working on a fresh
 * checkout even before those files exist. When a variable is added or removed,
 * update this list (and `.env.example`, its human-readable documentation).
 *
 * Set a variable to the exact text "N/A" to declare "this feature or value is
 * not available": it counts as present (the presence check passes) while
 * `env_available()` reports it as off, so a documented-but-unused feature stays
 * off without being flagged as missing.
 */

/** Exact text that marks a variable as intentionally unavailable (feature off). */
export const N_A = "N/A";

type EnvRecord = Record<string, string | undefined>;

/**
 * Stable source of truth for every environment variable the app knows about.
 * This is the union of the live `KEY=` assignments in `.env` and `.env.example`,
 * snapshot into code so it does not depend on either file existing at runtime.
 * Order follows `.env.example` (core first, optional features last); variables
 * present only in `.env` are appended in their section.
 */
export const KNOWN_ENV_VARS: readonly string[] = [
	// -- Core: database & server --
	"DEV_CONNECTION_STRING",
	"PROD_CONNECTION_STRING",
	"TEST_CONNECTION_STRING",
	"TIME_ZONE",
	"PORT",
	"TEST_PORT",
	"REEMAN_PORT",
	"MAIN_APP_URL",
	"SERVER_NAME",

	// -- Quick Start admin defaults --
	"ADMIN_USERNAME",
	"ADMIN_EMAIL",
	"ADMIN_PASSWORD",

	// -- Sessions / CSRF --
	"SESSION_STORE",
	"CSRF_SECRET",

	// -- Storage --
	"STORAGE",
	"LOCAL_STORAGE_DIR",

	// -- Email (SMTP) --
	"SMTP_ENABLED",
	"SMTP_HOST",
	"SMTP_PORT",
	"SMTP_USERNAME",
	"SMTP_PASSWORD",
	"SMTP_FROM",

	// -- Common app toggles --
	"SQL_LOGGING",
	"MAX_UPLOAD_SIZE_MB",
	"LOCALIZE_CONTENT",
	"GROUP_JS",
	"BUNDLE_JS",

	// -- Rate limiting --
	"RATE_LIMITING",
	"TRUST_PROXY",

	// -- Redis (optional) --
	"REDIS_ENABLED",
	"REDIS_URL",
	"TEST_REDIS_URL",
	"CACHE_ENABLED",
	"CACHE_MAX_BYTES",
	"CACHE_MAX_RECORDS",

	// -- S3 object storage (only when STORAGE="s3") --
	"S3_HOSTNAME",
	"S3_PORT",
	"S3_PROTOCOL",
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
	"S3_REGION",
	"S3_IMAGE_BUCKET",
	"S3_FILE_BUCKET",

	// -- Dev source inspector (optional, dev-only) --
	"OPEN_IDE",

	// -- AI / translation provider (optional) --
	"OPENROUTER_KEY",
	"OPENROUTER_MODEL",
	"GEMINI_API_KEY",
	"GEMINI_MODEL",
	"OPENAI_API_KEY",
	"OPENAI_MODEL",
	"CLAUDE_API_KEY",
	"CLAUDE_MODEL",
	"XAI_API_KEY",
	"XAI_MODEL",
	"OLLAMA_URL",
	"OLLAMA_MODEL",
	"HF_URL",
	"HF_MODEL",
	"HF_TOKEN",

	// -- MCP server (optional) --
	"MCP_ENABLE_TEMPLATE_RENDER",
	"MCP_ENABLE_MUTATIONS",
	"MCP_READONLY_CONNECTION_STRING",
	"MCP_SERVER_PORT",

	// -- Internal admin endpoints (optional) --
	"INTERNAL_ADMIN_ENDPOINTS",
	"RELOAD_SECRET",

	// -- Agent mode (optional, testing) --
	"AGENT_SERVER_PORT",
	"AGENT_REEMAN_SERVER_PORT",
	"AGENT_REEQA_SERVER_PORT",
	"AGENT_SECRET",
	"AGENT_USER_USERNAME",
];

/**
 * Allowed literal values for variables with a closed set (an enum). Compared
 * case-insensitively, so "local" and "LOCAL" both match. The "N/A" marker is
 * always accepted separately and means "feature off", so it never needs to be
 * listed here.
 */
export const env_var_values: Record<string, readonly (string | number)[]> = {
	STORAGE: ["local", "s3"],
	SESSION_STORE: ["sql", "redis"],
	TRUST_PROXY: ["cloudflare", "direct"],
	OPEN_IDE: ["vscode", "zed", "nvim", "sublime", "idea"],
	S3_PROTOCOL: ["http", "https"],
};

/**
 * Related variable groups gated by a single explicit switch var. When the
 * switch is "on" (`env_switch_on(switch)` true), every member must also be
 * real - a partial group (switch on, some members still `N/A`/absent) is a
 * silent misconfiguration: the feature looks "on" but fails - often with a
 * cryptic error several call frames away - once code reaches the missing
 * field. Listed here so `inconsistent_env_groups` catches the partial state
 * at boot with one clear message instead.
 *
 * S3 is deliberately not listed: its switch is the pre-existing `STORAGE=s3`,
 * already enforced loudly by `is_s3_configured()` in `lib/s3/core.ts`, and its
 * detail fields (`S3_PORT`/`S3_PROTOCOL`) have real code defaults rather than
 * being required members.
 */
export const env_var_groups: Record<string, { switch: string; members: readonly string[]; }> = {
	SMTP: { switch: "SMTP_ENABLED", members: ["SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"] },
};

function raw_value(name: string, env: EnvRecord): string | undefined {
	return env[name];
}

/**
 * True when the variable is present with a non-blank value. The `N_A` marker is
 * a real value, so a variable set to `N_A` counts as present (but see
 * `env_available()`).
 */
export function is_env_present(name: string, env: EnvRecord = Bun.env): boolean {
	const raw = raw_value(name, env);
	return raw !== undefined && raw.trim() !== "";
}

/**
 * True when the variable is present and does not carry the `N_A` marker. False
 * when absent OR set to `N_A`, which is the signal that the feature or value is
 * off. Feature checks should key off this rather than raw absence.
 */
export function env_available(name: string, env: EnvRecord = Bun.env): boolean {
	const raw = raw_value(name, env)?.trim();
	return raw !== undefined && raw !== "" && raw !== N_A;
}

/**
 * True only when a boolean switch var is explicitly enabled.
 *
 * A switch is on only for the exact literals "true" or "on" (case-insensitive,
 * surrounding whitespace ignored). Everything else - absent, blank, "N/A",
 * "false", and any other value - means off. This keeps switches off by default,
 * so a feature such as SMTP is enabled only by an explicit opt-in.
 */
export function env_switch_on(name: string, env: EnvRecord = Bun.env): boolean {
	const raw = raw_value(name, env)?.trim().toLowerCase();
	return raw === "true" || raw === "on";
}

/**
 * Whether Redis may be used at all.
 *
 * Redis is opt-in: it is available only when REDIS_ENABLED is explicitly
 * "true"/"on" AND REDIS_URL holds a real value. A configured URL on its own
 * no longer enables anything - the same false-by-default contract
 * `env_switch_on()` applies to every switch - so a developer can keep a
 * working URL in .env while Redis stays off (sessions, cache, queue, rate
 * limiting and feature flags fall back to their SQL equivalents).
 */
export function redis_available(env: EnvRecord = Bun.env): boolean {
	return env_switch_on("REDIS_ENABLED", env) && env_available("REDIS_URL", env);
}

/** Names from `names` that are not present (absent or blank) in `env`. */
export function missing_env_vars(names: readonly string[], env: EnvRecord = Bun.env): string[] {
	return names.filter((name) => !is_env_present(name, env));
}

export interface InvalidEnvVar {
	/** Variable name. */
	name: string;
	/** Value found in the environment (as written). */
	value: string;
	/** Allowed literal values. */
	allowed: readonly (string | number)[];
}

function is_allowed_value(value: string, allowed: readonly (string | number)[]): boolean {
	const normalized = value.toLowerCase();
	return allowed.some((entry) => String(entry).toLowerCase() === normalized);
}

/**
 * Variables set to a value outside their declared enum. Absent, blank, and
 * "N/A" values are not invalid - they are missing / unavailable instead.
 */
export function invalid_env_values(env: EnvRecord = Bun.env): InvalidEnvVar[] {
	const invalid: InvalidEnvVar[] = [];
	for (const [name, allowed] of Object.entries(env_var_values)) {
		const raw = raw_value(name, env)?.trim();
		if (raw === undefined || raw === "" || raw === N_A) continue;
		if (!is_allowed_value(raw, allowed)) invalid.push({ name, value: raw, allowed });
	}
	return invalid;
}

export interface InconsistentEnvGroup {
	/** Group name (key in `env_var_groups`). */
	group: string;
	/** The switch var that is turned on. */
	switch: string;
	/** Member vars still `N_A`/absent despite the switch being on. */
	missing_members: string[];
}

/**
 * Groups whose switch var is on (`env_switch_on(switch)`) while one or more
 * members are still `N_A`/absent. See `env_var_groups` for why this exists.
 */
export function inconsistent_env_groups(env: EnvRecord = Bun.env): InconsistentEnvGroup[] {
	const inconsistent: InconsistentEnvGroup[] = [];
	for (const [group, { switch: switch_name, members }] of Object.entries(env_var_groups)) {
		if (!env_switch_on(switch_name, env)) continue;
		const missing_members = members.filter((name) => !env_available(name, env));
		if (missing_members.length > 0) { inconsistent.push({ group, switch: switch_name, missing_members }); }
	}
	return inconsistent;
}

export interface EnvVarCheck {
	/** Every known variable name, from the committed `KNOWN_ENV_VARS` list. */
	names: string[];
	/** Known variables that are absent (or blank) from the environment. */
	missing: string[];
	/** Known variables present with a value other than `N_A`. */
	available: string[];
	/** Known variables explicitly marked `N_A` (feature off). */
	unavailable: string[];
	/** Known variables set to a value outside their declared enum. */
	invalid: InvalidEnvVar[];
	/** Groups whose switch is on while one or more members are still off. */
	inconsistent_groups: InconsistentEnvGroup[];
}

/** Split the known inventory into missing / available / N_A-marked / invalid. */
export function check_env_vars(env: EnvRecord = Bun.env): EnvVarCheck {
	const names = [...KNOWN_ENV_VARS];

	const missing: string[] = [];
	const available: string[] = [];
	const unavailable: string[] = [];

	for (const name of names) {
		if (!is_env_present(name, env)) missing.push(name);
		else if (env_available(name, env)) available.push(name);
		else unavailable.push(name);
	}

	return { names, missing, available, unavailable, invalid: invalid_env_values(env), inconsistent_groups: inconsistent_env_groups(env) };
}
