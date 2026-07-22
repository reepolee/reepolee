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
 * preserves surrounding quotes in CLI mode (e.g. `CONNECTION_STRING="sqlite:app.db"`
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
// Storage mode
// ---------------------------------------------------------------------------

export type StorageMode = "local" | "s3";

export function get_storage_mode(): StorageMode | null {
	const raw = Bun.env.STORAGE?.trim().toLowerCase();
	if (!raw) return null;
	if (raw === "local") return "local";
	if (raw === "s3") return "s3";
	console.error(`\x1b[31m✗ Invalid STORAGE env var "${raw}" - expected "local" or "s3"\x1b[0m`);
	process.exit(1);
}
