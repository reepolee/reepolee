#!/usr/bin/env bun

export interface RouteInsertResult {
	content: string;
	modified: boolean;
}

export function add_route_import(routes_content: string, handler_name: string, import_path: string): RouteInsertResult {
	const import_stmt = `import { ${handler_name} } from "$routes/${import_path}";`;

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

	const modified = routes_content.replace(/(const route_definitions: RouteDefinition\[\] = \[)([\s\S]*?)(\];)/, (_, start, body, end) => {
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
		return `${start}${result_body}\n${handler_entry}\n${end}\n`;
	});

	return { content: modified, modified: true };
}

export function add_static_route_definitions(routes_content: string, import_path: string): RouteInsertResult {
	const alias = import_path.replace(
		/\//g,
		"_"
	);
	const import_stmt = `import { route_definitions as ${alias} } from "$routes/${import_path}";`;
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
		const route_def_re = /(const route_definitions: RouteDefinition\[\] = \[)([\s\S]*?)(\];)/;
		if (!route_def_re.test(content)) {
			throw new Error(
				`Could not find "const route_definitions: RouteDefinition[] = [ ... ];" block in routes.ts - ` +
				`the array may be malformed (e.g. missing closing "];"). Fix routes.ts manually before regenerating.`
			);
		}
		content = content.replace(route_def_re, (_, start, body, end) => {
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
			return `${start}${body_lines.join("\n")}\n${spread}\n${end}\n`;
		});
		if (!content.includes(spread)) {
			throw new Error(`Failed to insert "${spread}" into route_definitions array in routes.ts.`);
		}
	}

	return { content, modified: true };
}
