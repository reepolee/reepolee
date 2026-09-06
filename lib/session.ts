/**
 * Session utilities for the auth system.
 * Session ID is stored in an HttpOnly, SameSite=Lax cookie.
 */

import { get_cookie } from "$lib/cookies";
import type { BunRequest } from "bun";

export const SESSION_COOKIE_NAME = "sid";

export function get_session_id_from_request(req: BunRequest): string | null { return get_cookie(req, SESSION_COOKIE_NAME); }
