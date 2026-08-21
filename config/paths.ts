/**
 * App tree locations - single source of truth for the directories that hold
 * the three peer apps and the shared platform routes.
 *
 * These are *filesystem* path segments. Translation-key namespaces that happen
 * to spell "routes" (see `lib/i18n.ts`) are a different concept and must never
 * be swapped for these constants - the key namespace stays literal when the
 * folder moves.
 */

import { join, sep } from "node:path";

/** Parent directory holding every app tree. Every child of it is a server. */
export const APPS_DIR = "apps";

/** Main app - target of generated CRUD. */
export const MAIN_APP = join(APPS_DIR, "main");

/** Reeman app - generator UI plus the sysadmin pages. */
export const REEMAN_APP = join(APPS_DIR, "reeman");

/** ReeQA app - QA dashboard. */
export const REEQA_APP = join(APPS_DIR, "reeqa");

/** Shared platform routes (auth, notfound). Not an app - it serves no port. */
export const PLATFORM_DIR = "platform";

/** Every app tree, in mount order. */
export const APP_DIRS: readonly string[] = [MAIN_APP, REEMAN_APP, REEQA_APP];

/**
 * `MAIN_APP` as path segments and in posix form, for code that matches a
 * relative path prefix rather than joining one.
 */
export const MAIN_APP_SEGMENTS: readonly string[] = MAIN_APP.split(sep);
export const MAIN_APP_POSIX = MAIN_APP_SEGMENTS.join("/");

/** Absolute directory of one app tree. */
export function app_dir(name: string, project_root: string = process.cwd()): string {
	return join(project_root, name);
}
