/**
 * Reusable helpers shared across auth route handlers.
 */

import { build_session_cookie } from "./cookies";
import { create_session, generate_session_id } from "./session_store";
import type { User_record } from "./sql";

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Create a new session for a verified user and return the Set-Cookie value.
 * Coerces all nullable DB fields to empty strings so the session store and
 * templates never receive null.
 */
export async function create_user_session(user: User_record): Promise<string> {
	const session_id = generate_session_id();
	await create_session(session_id, {
		user_id: user.id,
		email: user.email ?? "",
		name: user.name ?? "",
		nickname: user.nickname ?? "",
		username: user.username ?? "",
		avatar_filename: user.avatar_filename ?? "",
		display_name: user.nickname || user.name || user.username || "",
		modules_tags: user.modules_tags,
	});
	return build_session_cookie(session_id);
}
