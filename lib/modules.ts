import { db } from "$config/db";

let cached_prefixes: string[] | null = null;

export async function load_modules(): Promise<void> {
	try {
		const rows = await db`SELECT code FROM modules WHERE code != 'default' ORDER BY code`;
		cached_prefixes = rows.map((r: any) => (r.code as string).toLowerCase());
	} catch (error) {
		console.error("Failed to load modules:", error);
		cached_prefixes = [];
	}
}

export function get_available_prefixes(): string[] {
	if (cached_prefixes === null) {
		console.warn("get_available_prefixes called before load_modules()");
		return [];
	}
	return cached_prefixes;
}

export async function get_available_modules(): Promise<{ code: string; name: string; }[]> {
	try {
		const rows = await db`SELECT code, name FROM modules WHERE code != 'default' ORDER BY id`;
		return rows.map((r: any) => ({
			code: String(r.code ?? ""),
			name: String(r.name ?? r.code ?? ""),
		}));
	} catch {
		return [];
	}
}
