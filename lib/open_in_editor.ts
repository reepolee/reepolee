/**
 * Dev-only "open source in editor" support for the inspector. The browser
 * inspector POSTs a source-relative file + line to /__ree_open; this module
 * validates the path against the project root and launches the configured IDE
 * at the line.
 *
 * Which IDE is launched is set by the OPEN_IDE env var (in .env); IDE_COMMANDS
 * maps that key to an argv template where {file} and {line} are substituted.
 * Strict: OPEN_IDE must be set to a known key, no default. The path guard
 * mirrors lib/template/include_resolver.ts: resolve, then assert the target
 * stays under the project root.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as path_resolve, sep } from "node:path";

import { env_available } from "$config/env_vars";

// Per-IDE argv templates. {file} and {line} are substituted at launch. Editors
// differ in flag order (nvim wants +{line} before the file), so each entry
// encodes its own ordering. Add an editor by adding one row here.
export const IDE_COMMANDS: Record<string, string[]> = {
	vscode: ["code", "--goto", "{file}:{line}"],
	zed: ["zed", "{file}:{line}"],
	nvim: ["nvim", "+{line}", "{file}"],
	sublime: ["subl", "{file}:{line}"],
	idea: ["idea", "--line", "{line}", "{file}"],
};

/** The configured IDE key (OPEN_IDE env), or "" when unset. */
export function configured_ide(): string { return env_available("OPEN_IDE") ? (Bun.env.OPEN_IDE ?? "") : ""; }

/** Launch the configured IDE at file:line. Returns success plus any spawn error text. */
export function open_in_editor_at(file_abs: string, line: number): { success: boolean; error?: string; } {
	const ide = configured_ide();
	if (!ide) {
		return {
			success: false,
			error: `OPEN_IDE is not set (set it in .env to one of: ${Object.keys(IDE_COMMANDS).join(
				", "
			)})`,
		};
	}
	const template = IDE_COMMANDS[ide];
	if (!template) {
		return {
			success: false,
			error: `unknown OPEN_IDE "${ide}" (known: ${Object.keys(IDE_COMMANDS).join(", ")})`,
		};
	}
	const argv = template.map((part) => part.replace("{file}", file_abs).replace("{line}", String(
		line
	)));
	try {
		const proc = Bun.spawnSync(argv, { stdio: ["ignore", "pipe", "pipe"] });
		if (proc.exitCode !== 0) {
			const err = proc.stderr.toString().trim();
			return { success: false, error: err || `${ide} exited with ${proc.exitCode}` };
		}
		return { success: true };
	} catch (err) {
		return { success: false, error: String(err) };
	}
}

export type OpenValidation = { ok: true; file_abs: string; line: number; } | { ok: false; status: number; reason: string; };

/**
 * Validate a browser-supplied open request. `file_param` is interpreted
 * relative to `project_root` (the stamp path convention is project-root
 * relative, e.g. "apps/main/home.ree"). Absolute paths and any path that escapes
 * the project root are rejected.
 */
export function validate_open_request(project_root: string, file_param: string | null, line_param: string | null): OpenValidation {
	if (!file_param) return { ok: false, status: 400, reason: "missing file" };
	if (isAbsolute(file_param)) return {
		ok: false,
		status: 400,
		reason: "absolute paths not allowed",
	};

	const base_resolved = path_resolve(project_root);
	const candidate = join(base_resolved, file_param);
	const resolved = path_resolve(candidate);

	// Traversal guard: compare with a trailing separator so a sibling dir whose
	// name is a prefix of the base (e.g. /proj-evil vs /proj) cannot pass.
	const base_with_sep = base_resolved.endsWith(sep) ? base_resolved : base_resolved + sep;
	const inside = resolved === base_resolved || resolved.startsWith(base_with_sep);
	if (!inside) return {
		ok: false,
		status: 403,
		reason: `path escapes project root: ${file_param}`,
	};

	if (!existsSync(resolved)) return {
		ok: false,
		status: 404,
		reason: `not found: ${file_param}`,
	};

	const parsed_line = Number.parseInt(line_param ?? "1", 10);
	const line = Number.isFinite(parsed_line) && parsed_line > 0 ? parsed_line : 1;

	return { ok: true, file_abs: resolved, line };
}

/**
 * Handle a /__ree_open request end to end: validate, then launch the editor.
 * Returns a JSON Response with the appropriate status.
 */
export function handle_open_request(project_root: string, url: URL): Response {
	const file_param = url.searchParams.get("file");
	const line_param = url.searchParams.get("line");
	const validation = validate_open_request(project_root, file_param, line_param);

	if (!validation.ok) {
		const body = JSON.stringify({ error: validation.reason });
		return new Response(body, {
			status: validation.status,
			headers: { "Content-Type": "application/json" },
		});
	}

	const launched = open_in_editor_at(validation.file_abs, validation.line);
	if (!launched.success) {
		const body = JSON.stringify({ error: launched.error ?? "editor launch failed" });
		return new Response(body, { status: 500, headers: { "Content-Type": "application/json" } });
	}

	return new Response(JSON.stringify({ success: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
