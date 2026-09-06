// Columns never serialized over the read API regardless of table.
// Prevents accidentally publishing sensitive data when api = true is set on a table
// whose sql.ts does SELECT *.
export const API_BLOCKLIST: string[] = [
	"hashed_password",
	"previous_hashed_password",
	"invitation_code",
	"search_text",
	"password_hash",
];

export function strip_api_sensitive(rec: Record<string, unknown>): Record<string, unknown> {
	const clean: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(rec)) {
		if (!API_BLOCKLIST.includes(k)) clean[k] = v;
	}
	return clean;
}
