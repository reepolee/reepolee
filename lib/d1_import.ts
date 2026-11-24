/**
 * Import rows from a Cloudflare D1 database into an origin table.
 *
 * The target table contract, row mapping, dedupe hook, and upsert behavior
 * come from `sync_table()`. This wrapper only owns the D1 query and resolves
 * its credentials from the environment when they are not supplied directly.
 *
 * `source_sql` is for trusted, application-authored SELECT statements. Never
 * pass SQL built from a request or other untrusted input.
 */
import { d1_client_from_env, d1_query, d1_query_table, type D1ClientConfig, type D1Fetch } from "./d1_client";
import { sync_table, type TableSyncOptions, type TableSyncResult } from "./table_sync";

export interface D1ImportOptions extends Omit<TableSyncOptions, "fetch_rows"> {
	/** Named D1 table to read in full. Mutually exclusive with `source_sql`. */
	source_table?: string;
	/** Trusted D1 SELECT statement. Mutually exclusive with `source_table`. */
	source_sql?: string;
	/** Positional parameters for `source_sql`. */
	source_params?: unknown[];
	/** Explicit D1 credentials. Defaults to CF_* environment variables. */
	d1_config?: D1ClientConfig;
	/** Injectable fetch implementation for tests. */
	fetch_fn?: D1Fetch;
}

/** Fetch, reshape, and idempotently upsert a D1 source into one local table. */
export async function import_d1_table(options: D1ImportOptions): Promise<TableSyncResult> {
	const { source_table, source_sql, source_params, d1_config: configured_d1, fetch_fn, ...table_sync_options } = options;
	const has_source_table = source_table !== undefined;
	const has_source_sql = source_sql !== undefined;
	if (has_source_table === has_source_sql) {
		throw new Error("D1 import requires exactly one of source_table or source_sql.");
	}

	const d1_config = configured_d1 ?? d1_client_from_env();
	if (!d1_config) {
		throw new Error("D1 import is not configured. Set CF_API_TOKEN, CF_ACCOUNT_ID, and CF_D1_DATABASE_ID.");
	}

	const fetch_rows = async (): Promise<Record<string, unknown>[]> => {
		if (source_table !== undefined) {
			if (source_params !== undefined && source_params.length > 0) {
				throw new Error("source_params requires source_sql.");
			}
			return await d1_query_table(d1_config, source_table, { fetch_fn });
		}
		if (source_sql === undefined) {
			throw new Error("D1 import requires source_sql when source_table is absent.");
		}
		return await d1_query(d1_config, source_sql, source_params ?? [], { fetch_fn });
	};

	return await sync_table({ ...table_sync_options, fetch_rows });
}
