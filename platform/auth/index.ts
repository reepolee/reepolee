/**
 * Auth module: combines all sub-routes
 * Instead of one monolithic index.ts, auth functionality is split into:
 * - login: login/logout
 * - register: invitation-based registration
 * - profile: user profile management
 * - password: password change
 * - invite: admin invitation system
 */

import { invite_crud } from "./invite/index";
import { login_crud } from "./login/index";
import { password_crud } from "./password/index";
import { profile_crud } from "./profile/index";
import { register_crud } from "./register/index";

export const auth_crud = {
	...login_crud,
	...register_crud,
	...profile_crud,
	...password_crud,
	...invite_crud,
};
