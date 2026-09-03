import { env_available } from "$config/env_vars";

/**
 * Environment variable helpers.
 *
 * `require_env()` - fails loud with a red message and exits if the env var is
 * not set. Use at the point of need, not at a central startup check, so adding
 * a new required var is just a one-line change in the module that needs it.
 *
 * Also strips surrounding quotes from the value, because Bun passes `.env`
 * values with literal quote characters when running `bun run` directly.
 *
 * @see https://github.com/oven-sh/bun/issues/12493 - Bun's .env parsing
 * preserves surrounding quotes in CLI mode (e.g. `DEV_CONNECTION_STRING="sqlite:app.db"`
 * yields `'"sqlite:app.db"'`). This is a known Bun behavior; the sanitize
 * function strips them so callers get the intended value without awareness.
 */
export function require_env(name: string): string {
	const val = Bun.env[name];

	if (!val) {
		console.error(`\x1b[31m✗ Required environment variable ${name} is not set\x1b[0m`);
		process.exit(1);
	}
	return sanitize_env_value(val);
}

/**
 * Strip surrounding quotes and whitespace from an env value.
 * Bun's .env parser preserves quotes in values like `"sqlite:app.db"`.
 */
export function sanitize_env_value(raw: string): string { return raw.replace(/^["'\s]+|["'\s]+$/g, "").trim(); }

// ---------------------------------------------------------------------------
// Database connection string (dev / prod split)
// ---------------------------------------------------------------------------

export type Connection_environment = "DEV" | "PROD" | "TEST";

type Connection_env_names = {
	connection_string: `${Connection_environment}_CONNECTION_STRING`;
	username: `${Connection_environment}_DB_USERNAME`;
	password: `${Connection_environment}_DB_PASSWORD`;
};

const connection_env_names: Record<Connection_environment, Connection_env_names> = {
	DEV: {
		connection_string: "DEV_CONNECTION_STRING",
		username: "DEV_DB_USERNAME",
		password: "DEV_DB_PASSWORD",
	},
	PROD: {
		connection_string: "PROD_CONNECTION_STRING",
		username: "PROD_DB_USERNAME",
		password: "PROD_DB_PASSWORD",
	},
	TEST: {
		connection_string: "TEST_CONNECTION_STRING",
		username: "TEST_DB_USERNAME",
		password: "TEST_DB_PASSWORD",
	},
};

/**
 * Name of the env var holding the connection string for this process.
 *
 * The app runs against `PROD_CONNECTION_STRING` when started with `--prod`
 * (`bun start`), and against `DEV_CONNECTION_STRING` in every other mode.
 * Development tooling (reeman, most generators, `scripts/`, marketplace
 * installers) reads `DEV_CONNECTION_STRING` directly. The user generator is
 * the deliberate exception: its explicit `--prod` flag reads
 * `PROD_CONNECTION_STRING` to create a production user.
 */
export const CONNECTION_ENVIRONMENT: "DEV" | "PROD" = Bun.argv.includes("--prod") ? "PROD" : "DEV";

export const CONNECTION_STRING_VAR = connection_env_names[CONNECTION_ENVIRONMENT].connection_string;

/**
 * Resolve a DB URL for one environment. SQLite remains a self-contained URL.
 * MySQL endpoint URLs must omit userinfo; credentials come from separate
 * environment variables so a secret manager can supply them independently.
 */
export function get_connection_string(environment: Connection_environment = CONNECTION_ENVIRONMENT): string {
	const names = connection_env_names[environment];
	const connection_string = require_env(names.connection_string);
	if (!connection_string.toLowerCase().startsWith("mysql://")) return connection_string;

	const connection_url = new URL(connection_string);
	if (connection_url.username || connection_url.password) {
		console.error(`\x1b[31m✗ ${names.connection_string} must not include a MySQL username or password. Set ${names.username} and ${names.password} separately.\x1b[0m`);
		process.exit(1);
	}

	connection_url.username = require_env(names.username);
	connection_url.password = require_env(names.password);
	return connection_url.toString();
}

// ---------------------------------------------------------------------------
// Storage mode
// ---------------------------------------------------------------------------

export type StorageMode = "local" | "s3";

/**
 * Upload size limit in MB, read from MAX_UPLOAD_SIZE_MB (positive integer).
 * No fallback: missing, blank, "N/A", or a non-positive-integer value fails
 * loud. Shared by image uploads and the data-to-sql tool.
 */
export function require_max_upload_size_mb(): number {
	const name = "MAX_UPLOAD_SIZE_MB";
	if (!env_available(name)) {
		console.error(`\x1b[31m✗ Required environment variable ${name} is not set\x1b[0m`);
		process.exit(1);
	}
	const raw = sanitize_env_value(Bun.env[name]!);
	const mb = Number(raw);
	if (!Number.isInteger(mb) || mb <= 0) {
		console.error(`\x1b[31m✗ Invalid ${name} "${raw}" - expected a positive integer (MB)\x1b[0m`);
		process.exit(1);
	}
	return mb;
}

export function get_storage_mode(): StorageMode | null {
	// `env_available()` treats the exact "N/A" marker (and an absent/blank
	// value) as "not available", so STORAGE=N/A falls back to auto-detect
	// instead of exiting as an invalid value.
	if (!env_available("STORAGE")) return null;
	const raw = Bun.env.STORAGE?.trim().toLowerCase();
	if (raw === "local") return "local";
	if (raw === "s3") return "s3";
	console.error(`\x1b[31m✗ Invalid STORAGE env var "${raw}" - expected "local" or "s3"\x1b[0m`);
	process.exit(1);
}
