import { has_module } from "$platform/auth/middleware";
import type { Dev_app_link } from "$config/apps";

type App_switcher_auth_context = { current_user: { modules_tags?: string } | null; };

/** Return only the development apps the current authenticated user may reach. */
export function visible_apps(auth_ctx: App_switcher_auth_context, apps: readonly Dev_app_link[]): Dev_app_link[] {
	return apps.filter((app) => !app.module || has_module(auth_ctx.current_user?.modules_tags, app.module));
}
