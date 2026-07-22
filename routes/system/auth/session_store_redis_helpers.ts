import type { Session_data } from "./types";

type Redis_session_client = {
	scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", hint: number): Promise<[string, string[]]>;
	mget(...keys: string[]): Promise<Array<string | null>>;
	del(...keys: string[]): Promise<number>;
};

export async function destroy_user_sessions_in_redis(redis: Redis_session_client, user_id: number, key_prefix: string): Promise<void> {
	let cursor = "0";
	do {
		const [next_cursor, keys] = await redis.scan(cursor, "MATCH", `${key_prefix}*`, "COUNT", 100);
		cursor = next_cursor;
		if (!keys.length) continue;

		const values = await redis.mget(...keys);
		const user_keys = keys.filter((key, index) => {
			const value = values[index];
			if (!value) return false;
			try {
				return (JSON.parse(value) as Session_data).user_id === user_id;
			} catch {
				return false;
			}
		});

		if (user_keys.length) { await redis.del(...user_keys); }
	} while (cursor !== "0");
}
