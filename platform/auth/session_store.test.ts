import { afterEach, describe, expect, test } from "bun:test";

import "$lib/temporal";
import { db_type } from "$lib/resolve_db_type";

import session_store from "./session_store_sqlite";
import type { Session_data } from "./types";

const session_ids: string[] = [];
const { create_session, destroy_session, destroy_user_sessions, generate_session_id, get_session } = session_store;

function session_data(user_id: number): Omit<Session_data, "created_at"> {
	return {
		user_id,
		email: `user-${user_id}@example.test`,
		name: `User ${user_id}`,
		nickname: "",
		username: `user_${user_id}`,
		avatar_filename: "",
		display_name: `User ${user_id}`,
		modules_tags: "",
	};
}

afterEach(async () => {
	await Promise.all(session_ids.splice(0).map((session_id) => destroy_session(session_id)));
});

const run = db_type === "sqlite" ? describe : describe.skip;

run("session store user revocation", () => {
	test("removes every session for one user without affecting another user", async () => {
		const user_id = 41001;
		const other_user_id = 41002;
		const first_session_id = generate_session_id();
		const second_session_id = generate_session_id();
		const other_session_id = generate_session_id();
		session_ids.push(first_session_id, second_session_id, other_session_id);

		await Promise.all([
			create_session(first_session_id, session_data(user_id)),
			create_session(second_session_id, session_data(user_id)),
			create_session(other_session_id, session_data(other_user_id)),
		]);

		await destroy_user_sessions(user_id);

		expect(await get_session(first_session_id)).toBeNull();
		expect(await get_session(second_session_id)).toBeNull();
		expect((await get_session(other_session_id))?.user_id).toBe(other_user_id);
	});
});
