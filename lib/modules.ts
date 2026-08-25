import { db } from "$config/db";

// Store on globalThis so the cache survives bun --hot re-evaluations.
// Without this, every hot reload resets the module-level variable to null,
// and the hot reload path in server.ts doesn't re-call load_modules().
declare global {
	var __reepolee_modules_cache: string[] | null | undefined;
}

export async function load_modules(): Promise<void> {
	try {
		const rows = await db`SELECT code FROM modules WHERE code != 'default' ORDER BY code`;
		globalThis.__reepolee_modules_cache = rows.map((r: any) => (r.code as string).toLowerCase());
	} catch (error) {
		console.error("Failed to load modules:", error);
		globalThis.__reepolee_modules_cache = [];
	}
}

export function get_available_prefixes(): string[] {
	if (globalThis.__reepolee_modules_cache == null) {
		console.warn("get_available_prefixes called before load_modules()");
		return [];
	}
	return globalThis.__reepolee_modules_cache;
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
