/**
 * Cloudflare D1 HTTP API client.
 *
 * Queries a D1 database through the Cloudflare REST API, so a Reepolee app
 * can read from an edge D1 database (e.g. a public registration form's
 * applications) and sync them into origin tables via `lib/table_sync.ts`.
 *
 * Credentials come from the environment by default (CF_API_TOKEN,
 * CF_ACCOUNT_ID, CF_D1_DATABASE_ID) but can be passed explicitly for
 * callers that resolve them elsewhere.
 *
 * Reference: https://developers.cloudflare.com/api/operations/cloudflare-d1-query-database
 */

export interface D1ClientConfig {
	api_token: string;
	account_id: string;
	database_id: string;
	/** Override for tests / self-hosted API mirrors. */
	api_base_url?: string;
}

export interface D1QueryResult {
	success: boolean;
	errors: { code?: number; message: string }[];
	/** One entry per statement; `result[0].results` holds the rows. */
	result?: { results: Record<string, unknown>[]; meta?: Record<string, unknown>; success: boolean }[];
}

/** Read D1 credentials from the environment, or null when any is missing. */
export function d1_client_from_env(env: Record<string, string | undefined> = Bun.env): D1ClientConfig | null {
	const api_token = env.CF_API_TOKEN;
	const account_id = env.CF_ACCOUNT_ID;
	const database_id = env.CF_D1_DATABASE_ID;
	if (!api_token || !account_id || !database_id) return null;
	return { api_token, account_id, database_id };
}

export function d1_query_endpoint(config: D1ClientConfig, path: string): string {
	const base = config.api_base_url ?? "https://api.cloudflare.com/client/v4";
	return `${base}/accounts/${encodeURIComponent(config.account_id)}/d1/database/${encodeURIComponent(config.database_id)}${path}`;
}

/**
 * Run a single SQL statement against the D1 database and return its rows.
 * `params` bind positionally (D1 uses `?` placeholders).
 */
export async function d1_query(
	config: D1ClientConfig,
	sql: string,
	params: unknown[] = [],
	options: { fetch_fn?: typeof fetch } = {},
): Promise<Record<string, unknown>[]> {
	const fetch_fn = options.fetch_fn ?? fetch;
	const response = await fetch_fn(d1_query_endpoint(config, "/query"), {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${config.api_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ sql, params }),
	});

	if (!response.ok) {
		const body_text = await response.text().catch(() => "");
		throw new Error(`D1 query failed with HTTP ${response.status}: ${body_text.slice(0, 300)}`);
	}

	const payload = (await response.json()) as D1QueryResult;
	if (!payload.success) {
		const message = payload.errors?.map((error) => error.message).join("; ") || "unknown error";
		throw new Error(`D1 query rejected: ${message}`);
	}
	const first = payload.result?.[0];
	if (!first) return [];
	return first.results ?? [];
}

/** SELECT * helper for callers that want the whole table. */
export async function d1_query_table(
	config: D1ClientConfig,
	table: string,
	options: { fetch_fn?: typeof fetch } = {},
): Promise<Record<string, unknown>[]> {
	return d1_query(config, `SELECT * FROM ${table}`, [], options);
}
