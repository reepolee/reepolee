import { describe, expect, test } from "bun:test";

import { destroy_user_sessions_in_redis } from "./session_store_redis_helpers";

describe("destroy_user_sessions_in_redis", () => {
	test("deletes matching sessions across scan batches without touching other sessions", async () => {
		const values = new Map([
			["session:first", JSON.stringify({ user_id: 7 })],
			["session:other", JSON.stringify({ user_id: 8 })],
			["session:second", JSON.stringify({ user_id: 7 })],
			["session:invalid", "not-json"],
		]);
		const deleted: string[] = [];
		const redis = {
			scan: async (cursor: string) => {
				if (cursor === "0") { return ["1", ["session:first", "session:other"]] as [string, string[]]; }
				return ["0", ["session:second", "session:invalid"]] as [string, string[]];
			},
			mget: async (...keys: string[]) => keys.map((key) => values.get(key) || null),
			del: async (...keys: string[]) => {
				deleted.push(...keys);
				return keys.length;
			},
		};

		await destroy_user_sessions_in_redis(redis, 7, "session:");

		expect(deleted).toEqual(["session:first", "session:second"]);
	});
});
