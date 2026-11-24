/**
 * Dev-only inspector WebSocket message dispatch, carried over the existing
 * /__reload socket (see lib/livereload.ts, server.ts's websocket_config).
 *
 * Messages (client -> server):
 *   { type: "i18n_get",     key, id }               -> current translation
 *   { type: "i18n_update",  key, value, id }         -> resolve + save, return saved
 *   { type: "class_get",    file, line, tag, id }    -> current class value
 *   { type: "class_update", file, line, tag, value, id } -> patch, return saved
 * Replies (server -> client), echoing `id`:
 *   { type: "i18n_value",  id, ok, value?, error? }
 *   { type: "i18n_saved",  id, ok, error? }
 *   { type: "class_value", id, ok, value?, has_attr?, error? }
 *   { type: "class_saved", id, ok, error? }
 *
 * class_get/class_update file paths are validated against the project root
 * (same guard as /__ree_open) before any read or write. i18n_get/i18n_update
 * resolve the dotted template path to a DB row for `locale`, disambiguated by
 * the source `file` (stamped by data-ree-i18n-file, validated against the
 * project root, then resolved to an exact namespace via
 * route_namespace_from_dir()) when the same key_path exists under more than
 * one namespace, falling back to a segment match against the page `url` if
 * the file can't be resolved - see lib/inspector_i18n_write.ts.
 */

import { dirname } from "node:path";
import { patch_class_in_source, read_class_from_source } from "$lib/inspector_class_write";
import { get_i18n_value, update_i18n_value } from "$lib/inspector_i18n_write";
import { canonical_locale } from "$lib/locale";
import { validate_open_request } from "$lib/open_in_editor";
import { route_namespace_from_dir } from "$lib/route";

type IncomingMessage = {
	type: "i18n_get";
	key: string;
	locale?: string;
	url?: string;
	file?: string;
	id?: string | number;
} | {
	type: "i18n_update";
	key: string;
	value: string;
	locale?: string;
	url?: string;
	file?: string;
	id?: string | number;
} | {
	type: "class_get";
	file: string;
	line: number;
	tag: string;
	id?: string | number;
} | {
	type: "class_update";
	file: string;
	line: number;
	tag: string;
	value: string;
	id?: string | number;
};

const HANDLED_TYPES = new Set(["i18n_get", "i18n_update", "class_get", "class_update"]);

/**
 * Resolve a stamped source `file` (project-root-relative) to its translation
 * namespace, for disambiguating a key_path that exists under several
 * namespaces. Reuses the same project-root guard as /__ree_open; returns
 * null for a missing/invalid/out-of-project file rather than failing the
 * whole i18n request - callers fall back to URL-based disambiguation.
 */
function resolve_namespace_hint(project_root: string, file: string | undefined): string | null {
	if (!file) return null;
	const validation = validate_open_request(project_root, file, "1");
	if (!validation.ok) return null;
	try {
		return route_namespace_from_dir(dirname(validation.file_abs));
	} catch {
		return null;
	}
}

/**
 * Handle a parsed inspector message. Returns true if the message was ours
 * (handled), false otherwise (caller may handle it, or ignore).
 */
export async function handle_inspector_message(ws: { send(data: string): void; }, raw: string, project_root: string, locale: string): Promise<boolean> {
	let msg: IncomingMessage;
	try {
		msg = JSON.parse(raw);
	} catch {
		return false;
	}
	if (msg == null || !HANDLED_TYPES.has(msg.type)) return false;

	if (msg.type === "i18n_get" || msg.type === "i18n_update") {
		const reply_type = msg.type === "i18n_get" ? "i18n_value" : "i18n_saved";
		const url = msg.url ?? "";
		const target_locale = canonical_locale(msg.locale) ?? locale;
		const namespace_hint = resolve_namespace_hint(project_root, msg.file);
		if (msg.type === "i18n_get") {
			const result = await get_i18n_value(target_locale, msg.key, url, namespace_hint);
			ws.send(JSON.stringify(result.ok ? { type: reply_type, id: msg.id, ok: true, value: result.value } : {
				type: reply_type,
				id: msg.id,
				ok: false,
				error: result.reason,
			}));
			return true;
		}
		const result = await update_i18n_value(target_locale, msg.key, msg.value, url, namespace_hint);
		ws.send(JSON.stringify(result.ok ? { type: reply_type, id: msg.id, ok: true } : {
			type: reply_type,
			id: msg.id,
			ok: false,
			error: result.reason,
		}));
		return true;
	}

	// class_get / class_update
	const reply_type = msg.type === "class_get" ? "class_value" : "class_saved";
	const validation = validate_open_request(project_root, msg.file, String(msg.line));
	if (!validation.ok) {
		ws.send(JSON.stringify({ type: reply_type, id: msg.id, ok: false, error: validation.reason }));
		return true;
	}
	const file_abs = validation.file_abs;
	const line = validation.line;
	const tag = String(msg.tag ?? "").toLowerCase();
	if (!tag) {
		ws.send(JSON.stringify({ type: reply_type, id: msg.id, ok: false, error: "missing tag" }));
		return true;
	}

	const source = await Bun.file(file_abs).text();

	if (msg.type === "class_get") {
		const result = read_class_from_source(source, line, tag);
		ws.send(JSON.stringify(result.ok ? { type: "class_value", id: msg.id, ok: true, value: result.value, has_attr: result.has_attr } : {
			type: "class_value",
			id: msg.id,
			ok: false,
			error: result.reason,
		}));
		return true;
	}

	// class_update
	const patched = patch_class_in_source(source, line, tag, msg.value);
	if (!patched.ok) {
		ws.send(JSON.stringify({ type: "class_saved", id: msg.id, ok: false, error: patched.reason }));
		return true;
	}
	await Bun.write(file_abs, patched.source);
	ws.send(JSON.stringify({ type: "class_saved", id: msg.id, ok: true }));
	return true;
}
