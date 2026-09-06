import { get_connection_string, sanitize_env_value } from "$lib/env";

function resolve_db_type(): "mysql" | "sqlite" {
	const conn = sanitize_env_value(get_connection_string()).toLowerCase();
	if (conn.startsWith("mysql://")) return "mysql";
	if (conn.startsWith("sqlite://") || conn.endsWith(".sqlite") || conn.endsWith(".db")) return "sqlite";
	return "mysql";
}

export const db_type = resolve_db_type();
