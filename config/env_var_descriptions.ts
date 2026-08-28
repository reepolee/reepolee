/**
 * Human-readable description for every variable in `KNOWN_ENV_VARS`.
 *
 * Committed in code for the same reason the inventory itself is (see
 * `config/env_vars.ts`): nothing here may depend on `.env` or `.env.example`
 * existing at runtime. The reeman `/environment` page used to parse the comment
 * blocks out of `.env.example`, which meant descriptions vanished on any
 * install that did not ship that file, and the text a key got depended on
 * comment placement and separator heuristics.
 *
 * `.env.example` stays the human-facing template. This map is what the UI
 * reads. When a variable is added, add it to `KNOWN_ENV_VARS` and to this map -
 * `env_var_descriptions.test.ts` fails if the two ever drift.
 */

export const ENV_VAR_DESCRIPTIONS: Record<string, string> = {
	// -- Databases --
	DEV_CONNECTION_STRING: "Development DB - used by `bun dev`, reeman, the generators and every script under scripts/. Development tooling only ever touches this one.",
	PROD_CONNECTION_STRING: "Production DB - used only when the server is started with --prod (`bun start`). Required to boot in production.",
	TEST_CONNECTION_STRING: "Test DB - used by `bun test` and `bun run db:clone-test`. Must contain \"test\" in the DB name; the safety guard refuses non-test DBs.",

	// -- Core app --
	TIME_ZONE: "IANA time zone (e.g. \"Europe/Ljubljana\") used for date, time and timestamp columns. Required.",
	PORT: "Port the main app binds to. Defaults to 2338.",
	TEST_PORT: "Overrides PORT under the --test flag (binds to 127.0.0.1 only). Falls back to PORT then 2338. \"N/A\" means no override.",
	REEMAN_PORT: "Port for the reeman app (apps/reeman/server.ts), a second process serving the generator UI and sysadmin pages from this checkout. Defaults to 2339.",
	REEQA_PORT: "Port for the ReeQA app (apps/reeqa/server.ts). Required; set an explicit valid TCP port.",
	MAIN_APP_URL: "Base URL of the main app, used by the reeman process to reload the main app's translations across the two-app split.",
	SERVER_NAME: "Hostname used when building self-referencing URLs (reload notifications, agent mode). Defaults to localhost.",

	// -- Seeded admin account --
	ADMIN_USERNAME: "Username for the seeded admin account.",
	ADMIN_EMAIL: "Email address for the seeded admin account.",
	ADMIN_PASSWORD: "Password for the seeded admin account. \"N/A\" leaves it unset - you are prompted to type one instead of accepting a weak default.",

	// -- Sessions / CSRF --
	SESSION_STORE: "Where sessions are stored: \"sql\" (default, no extra services) or \"redis\" (requires REDIS_ENABLED=true and REDIS_URL).",
	CSRF_SECRET: "HMAC key for signing CSRF tokens. Required in production, where the server refuses to boot without it. Must be >= 32 chars. Dev and test fall back to an ephemeral per-process value. Generate with: openssl rand -base64 48",

	// -- Storage --
	STORAGE: "Where uploads live: \"local\" keeps them on disk, \"s3\" uses the S3 block. \"N/A\" auto-detects.",
	LOCAL_STORAGE_DIR: "Directory for uploads when STORAGE=\"local\". Relative paths resolve from the project root.",

	// -- Email --
	SMTP_ENABLED: "Switch for email delivery. Off by default; only \"true\" or \"on\" enables sending (\"false\", \"N/A\" and unset keep it off while preserving the SMTP values below). Once on, every SMTP field must hold a real value or boot fails.",
	SMTP_HOST: "SMTP server hostname. Required when SMTP_ENABLED=true.",
	SMTP_PORT: "SMTP server port (typically 587 for STARTTLS, 465 for TLS). Required when SMTP_ENABLED=true.",
	SMTP_USERNAME: "SMTP account username. Required when SMTP_ENABLED=true.",
	SMTP_PASSWORD: "SMTP account password. Required when SMTP_ENABLED=true.",
	SMTP_FROM: "From address on outgoing mail. Required when SMTP_ENABLED=true.",

	// -- Common app toggles --
	SQL_LOGGING: "Set to \"true\" to log every SQL statement to logs/sql/. Development aid; leave off in production.",
	MAX_UPLOAD_SIZE_MB: "Upload size limit in MB, shared by image uploads and the data-to-sql tool. Required - missing or \"N/A\" fails loudly at the upload point rather than applying a silent default.",
	LOCALIZE_CONTENT: "When \"true\", reeman marks every text/textarea/markdown field `localized: true` in newly generated schema columns. Existing table.ts files are never rewritten.",
	GROUP_JS: "Off by default. Set to \"true\" (or \"on\") to group a page's script tags into one immediate and one deferred file, cached to disk. Unset or \"false\" leaves each script tag as its own request.",
	BUNDLE_JS: "Set to \"true\" to additionally minify grouped output via Bun.build. Off by default: bundled scripts are hand-authored globals, and dead-code elimination can drop declarations used only by inline scripts. No effect when GROUP_JS=false.",

	// -- Rate limiting --
	RATE_LIMITING: "Brute-force protection on /login, /password and /register in production. Ignored in --dev; set \"true\" (or \"on\") to enable it in production. Production warns when it is off.",
	TRUST_PROXY: "How the limiter finds the real client IP: \"cloudflare\" (CF-Connecting-IP trusted, origin firewall must allow only Cloudflare) or \"direct\" (socket peer address, no proxy in front). Production requires one of the two.",

	// -- Redis (optional) --
	REDIS_ENABLED: "Switch for Redis. Off by default - only \"true\" or \"on\" enables Redis. A configured REDIS_URL alone no longer enables it: keep the URL in place while Redis stays off, and sessions, cache, queue, rate limiting and feature flags use their SQL equivalents.",
	REDIS_URL: "Redis/Valkey connection URL, shared by sessions, the SQL cache, the background queue and rate limiting. Takes effect only when REDIS_ENABLED=true (or \"on\"); \"N/A\" keeps the Redis-free install on the SQL stores.",
	TEST_REDIS_URL: "Real Redis for Redis-backed tests. Use a different DB number (e.g. /1) to isolate from the dev server. \"N/A\" skips those tests.",
	CACHE_ENABLED: "Set to \"true\" to enable Redis-backed caching of search_records queries. Requires REDIS_ENABLED=true and REDIS_URL. Falls back silently when disabled.",
	CACHE_MAX_BYTES: "Max serialized bytes for a cached value. \"N/A\" uses the default (524288 = 512 KB).",
	CACHE_MAX_RECORDS: "Max record count for cached query results. \"N/A\" uses the default (500).",

	// -- S3 object storage (only when STORAGE="s3") --
	S3_HOSTNAME: "S3 endpoint hostname. The endpoint is built as S3_PROTOCOL://S3_HOSTNAME:S3_PORT.",
	S3_PORT: "S3 endpoint port.",
	S3_PROTOCOL: "S3 endpoint protocol, \"http\" or \"https\".",
	S3_ACCESS_KEY_ID: "S3 access key ID.",
	S3_SECRET_ACCESS_KEY: "S3 secret access key.",
	S3_REGION: "S3 region. Optional for most S3-compatible servers.",
	S3_IMAGE_BUCKET: "Bucket for images uploaded through the image editor. Defaults to \"images\".",
	S3_FILE_BUCKET: "Bucket for documents uploaded through the file library. Defaults to \"files\".",

	// -- Editor integration --
	OPEN_IDE: "Editor launched by the inspector's \"open in editor\" action: vscode, zed, nvim, sublime or idea. \"N/A\" leaves that tier disabled; the rest of the inspector still works.",

	// -- AI translation providers --
	OPENROUTER_KEY: "API key for OpenRouter, used by the AI translation tools.",
	OPENROUTER_MODEL: "Model identifier to request from OpenRouter.",
	GEMINI_API_KEY: "API key for Google Gemini, used by the AI translation tools.",
	GEMINI_MODEL: "Gemini model identifier to request.",
	OPENAI_API_KEY: "API key for OpenAI, used by the AI translation tools.",
	OPENAI_MODEL: "OpenAI model identifier to request.",
	CLAUDE_API_KEY: "API key for Anthropic Claude, used by the AI translation tools.",
	CLAUDE_MODEL: "Claude model identifier to request.",
	XAI_API_KEY: "API key for xAI, used by the AI translation tools.",
	XAI_MODEL: "xAI model identifier to request.",
	OLLAMA_URL: "Base URL of a local Ollama server for offline translation.",
	OLLAMA_MODEL: "Ollama model name to run.",
	HF_URL: "Base URL for Hugging Face inference. The language pair (e.g. \"en-sl\") is derived automatically and appended to HF_MODEL.",
	HF_MODEL: "Hugging Face translation model prefix; the language pair is appended to it.",
	HF_TOKEN: "Hugging Face API token.",

	// -- MCP server --
	MCP_ENABLE_TEMPLATE_RENDER: "Set to \"true\" to let the MCP server render .ree templates, which executes local code. Off by default. Local stdio only - never expose the MCP bridge on a network port.",
	MCP_ENABLE_MUTATIONS: "Set to \"true\" to allow MCP tools that write (generators, translation edits). Off by default.",
	MCP_READONLY_CONNECTION_STRING: "MySQL only: a SELECT-only database user for MCP inspection. \"N/A\" means SQLite inspection uses its own read-only URL instead.",
	MCP_SERVER_PORT: "Port reported to MCP clients by the `project` tool as the app's server port. Defaults to 2400.",

	// -- Internal admin endpoints --
	INTERNAL_ADMIN_ENDPOINTS: "Set to \"true\" to expose the internal translation-reload and rate-limit endpoints. Off by default; enable only where those endpoints are needed, together with RELOAD_SECRET.",
	RELOAD_SECRET: "Shared secret for the internal admin endpoints, sent as X-Reload-Secret. Must be >= 32 chars. Generate with: openssl rand -hex 32",

	// -- Agent mode --
	AGENT_SERVER_PORT: "Dedicated port for the main app's agent mode. Required by `bun run agent` - it exits without one and never falls back to PORT. \"N/A\" = agent mode off.",
	AGENT_REEMAN_SERVER_PORT: "Dedicated port for the reeman app's agent mode. \"N/A\" = agent mode off.",
	AGENT_REEQA_SERVER_PORT: "Dedicated port for the ReeQA app's agent mode. \"N/A\" = agent mode off.",
	AGENT_SECRET: "Optional shared secret for agent-mode auth, as defense in depth. \"N/A\" requires no secret.",
	AGENT_USER_USERNAME: "Username agent mode authenticates as when acting on behalf of a real account.",

	// -- Cloudflare D1 (optional) --
	CF_API_TOKEN: "Cloudflare API token with D1 read access. \"N/A\" disables the D1 client.",
	CF_ACCOUNT_ID: "Cloudflare account id hosting the D1 database. \"N/A\" disables the D1 client.",
	CF_D1_DATABASE_ID: "D1 database id to query (the edge registration database). \"N/A\" disables the D1 client.",
};

/** Description for `name`, or an empty string when the variable has none. */
export function env_var_description(name: string): string {
	return ENV_VAR_DESCRIPTIONS[name] ?? "";
}
