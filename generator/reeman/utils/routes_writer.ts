#!/usr/bin/env bun

import { MAIN_APP_POSIX } from "$config/paths";

export interface RouteInsertResult {
	content: string;
	modified: boolean;
}

function route_import_alias(import_path: string): string {
	const alias = import_path.replace(/[^a-zA-Z0-9_$]/g, "_");
	return /^[a-zA-Z_$]/.test(alias) ? alias : `_${alias}`;
}

export function add_route_import(routes_content: string, handler_name: string, import_path: string): RouteInsertResult {
	const import_stmt = `import { ${handler_name} } from "$main/${import_path}";`;

	if (routes_content.includes(import_stmt)) { return { content: routes_content, modified: false }; }

	const lines = routes_content.split("\n");
	const last_idx = lines.findLastIndex((l) => l.trim().startsWith("import "));
	lines.splice(last_idx + 1, 0, import_stmt);
	return { content: lines.join("\n"), modified: true };
}

export function add_route_def_entry(
	routes_content: string,
	route_prefix: string,
	folder_name: string,
	handler_name: string,
	clean_prefix: string,
): RouteInsertResult {
	const nav_key = clean_prefix ? `${clean_prefix}.${folder_name}` : folder_name;
	const nav_module = clean_prefix ? `, module: "${clean_prefix}"` : "";
	const handler_entry = `\t{ url: "${route_prefix}/${folder_name}", handler: ${handler_name}, nav_title_key: "${nav_key}"${nav_module} },`;

	if (routes_content.includes(handler_entry)) {
		return { content: routes_content, modified: false };
	}

	const route_def_re = /(const route_definitions: RouteDefinition\[\] = \[[\s\S]*?)(\n\];)/;
	if (!route_def_re.test(routes_content)) {
		throw new Error(`Could not find the route_definitions array in ${MAIN_APP_POSIX}/routes.ts.`);
	}
	const modified = routes_content.replace(route_def_re, (_, body, end) => {
		const body_lines = body.split("\n");
		let last_line_idx = -1;
		for (let i = body_lines.length - 1; i >= 0; i--) {
			const trimmed = body_lines[i].trim();
			if (trimmed.length > 0 && !trimmed.startsWith("//")) {
				last_line_idx = i;
				break;
			}
		}

		if (last_line_idx >= 0) {
			const last_line = body_lines[last_line_idx].trimEnd();
			if (!last_line.endsWith(",")) { body_lines[last_line_idx] = `${last_line},`; }
		}

		const result_body = body_lines.join("\n");
		return `${result_body}\n${handler_entry}${end}\n`;
	});

	if (modified === routes_content) {
		throw new Error(`Failed to add the route definition for "${route_prefix}/${folder_name}" to ${MAIN_APP_POSIX}/routes.ts.`);
	}
	return { content: modified, modified: true };
}

/**
 * Guard against silently losing code after the route_definitions array (e.g. the
 * `export const nav_routes = ...;` line): every non-blank line that appears after the
 * array's closing "];" in the original content must still appear somewhere in the new
 * content. This catches a lazy-regex insertion accidentally consuming the tail of the file.
 */
function assert_tail_preserved(original: string, updated: string, array_close_re: RegExp): void {
	const close_idx = original.search(array_close_re);
	if (close_idx === -1) return; // nothing to check - caller already validated the array exists
	const tail_start = original.indexOf("\n", close_idx);
	if (tail_start === -1) return;
	const original_tail_lines = original
		.slice(tail_start)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	for (const line of original_tail_lines) {
		if (!updated.includes(line)) {
			throw new Error(
				`Refusing to write routes.ts: a line that existed after the route_definitions array would be lost: "${line}". ` +
				`This usually means routes.ts was modified by two overlapping generator runs. Aborting without writing - fix routes.ts manually and retry.`
			);
		}
	}
}

export function add_static_route_definitions(routes_content: string, import_path: string): RouteInsertResult {
	const alias = route_import_alias(import_path);
	const import_stmt = `import { route_definitions as ${alias} } from "$main/${import_path}";`;
	const spread = `\t...${alias},`;

	if (routes_content.includes(import_stmt) && routes_content.includes(spread)) {
		return { content: routes_content, modified: false };
	}

	let content = routes_content;

	if (!content.includes(import_stmt)) {
		const lines = content.split("\n");
		const last_idx = lines.findLastIndex((l) => l.trim().startsWith("import "));
		lines.splice(last_idx + 1, 0, import_stmt);
		content = lines.join("\n");
	}

	if (!content.includes(spread)) {
		const route_def_re = /(const route_definitions: RouteDefinition\[\] = \[[\s\S]*?)(\n\];)/;
		if (!route_def_re.test(content)) {
			throw new Error(
				`Could not find "const route_definitions: RouteDefinition[] = [ ... ];" block in routes.ts - ` +
				`the array may be malformed (e.g. missing closing "];"). Fix routes.ts manually before regenerating.`
			);
		}
		const before_insert = content;
		content = content.replace(route_def_re, (_, body, end) => {
			const body_lines = body.split("\n");
			let last_line_idx = -1;
			for (let i = body_lines.length - 1; i >= 0; i--) {
				const trimmed = body_lines[i].trim();
				if (trimmed.length > 0 && !trimmed.startsWith("//")) {
					last_line_idx = i;
					break;
				}
			}
			if (last_line_idx >= 0) {
				const last_line = body_lines[last_line_idx].trimEnd();
				if (!last_line.endsWith(",")) { body_lines[last_line_idx] = `${last_line},`; }
			}
			return `${body_lines.join("\n")}\n${spread}${end}\n`;
		});
		if (!content.includes(spread)) {
			throw new Error(`Failed to insert "${spread}" into route_definitions array in routes.ts.`);
		}
		assert_tail_preserved(before_insert, content, route_def_re);
	}

	return { content, modified: true };
}

export function add_module_route_entry(routes_content: string, module_code: string): RouteInsertResult {
	const has_import = /import\s+{[^}]*try_load_routes[^}]*}\s+from\s+["']?\$lib\/route_module["']?;/.test(routes_content);
	if (!has_import) {
		throw new Error(`${MAIN_APP_POSIX}/routes.ts must import try_load_routes before modules can be registered.`);
	}

	const module_reference = `import.meta.resolve("./${module_code}")`;
	if (routes_content.includes(module_reference)) {
		return { content: routes_content, modified: false };
	}

	const system_marker = "\n\t// GEN:MODULES";
	if (!routes_content.includes(system_marker)) {
		throw new Error(`Could not find the GEN:MODULES marker in routes/routes.ts.`);
	}

	const module_entry = `\t...await try_load_routes(${module_reference}),`;
	const replacement = `\n${module_entry}\n\n\t// GEN:MODULES`;
	const content = routes_content.replace(system_marker, replacement);
	return { content, modified: true };
}
