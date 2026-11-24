/**
 * Template MCP tools - render/validate/compile/analyze .ree templates and
 * read component sources. Rendering tools are gated behind
 * MCP_ENABLE_TEMPLATE_RENDER since they execute local code.
 */
import { existsSync } from "node:fs";
import { file } from "bun";

import TemplateEngine from "$lib/template_engine";

import { analyze_template, list_components } from "./project";
import { resolve_template_file } from "./paths";
import { text_content, json_content } from "./tools_common";
import type { Tool } from "./tools_common";

export function template_tools(deps: {
	engine: TemplateEngine;
	default_template_data: (userData: Record<string, any>) => Record<string, any>;
	assert_template_rendering_enabled: () => void;
}): Tool[] {
	const { engine, default_template_data, assert_template_rendering_enabled } = deps;
	return [
		{
			name: "render_template",
			description: "Execute and render a .ree template string locally. Requires MCP_ENABLE_TEMPLATE_RENDER=true.",
			inputSchema: {
				type: "object",
				properties: {
					template: { type: "string", description: "The .ree template content to render" },
					data: {
						type: "object",
						description: "Data object to pass to the template (common vars like locale, is_dev, user are auto-injected)",
						additionalProperties: true,
					},
				},
				required: ["template"],
			},
			handler: async (args) => {
				assert_template_rendering_enabled();
				const html = await engine.render_string(args.template, default_template_data(args.data || {}));
				return text_content(html);
			},
		},
		{
			name: "validate_template",
			description: "Validate .ree template syntax without rendering - returns valid flag and any errors",
			inputSchema: {
				type: "object",
				properties: {
					template: { type: "string", description: "The .ree template content to validate" },
				},
				required: ["template"],
			},
			handler: async (args) => {
				try {
					engine.compile_to_code(args.template);
					return text_content(JSON.stringify({ valid: true, errors: [] }));
				} catch (e: any) {
					return text_content(JSON.stringify({ valid: false, errors: [e.message] }));
				}
			},
		},
		{
			name: "compile_template",
			description: "Compile a .ree template and show the generated JavaScript source code",
			inputSchema: {
				type: "object",
				properties: {
					template: { type: "string", description: "The .ree template content to compile" },
				},
				required: ["template"],
			},
			handler: async (args) => {
				try {
					const { code } = engine.compile_to_code(args.template);
					return text_content(code);
				} catch (e: any) {
					return text_content(`// Compilation error:\n// ${e.message}`);
				}
			},
		},
		{
			name: "analyze_template",
			description: "Analyze a .ree template and extract its structure - layout, includes, components, variables, conditionals, loops",
			inputSchema: {
				type: "object",
				properties: {
					template: { type: "string", description: "The .ree template content to analyze" },
				},
				required: ["template"],
			},
			handler: async (args) => {
				const analysis = analyze_template(args.template);
				return json_content(analysis);
			},
		},
		{
			name: "list_components",
			description: "List all available .ree component files in the components directory",
			inputSchema: { type: "object", properties: {} },
			handler: async () => {
				const components = list_components();
				return json_content({ components });
			},
		},
		{
			name: "get_component_source",
			description: "Read the source of a .ree component by name",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string", description: "Component name (without .ree extension)" } },
				required: ["name"],
			},
			handler: async (args) => {
				const component_path = resolve_template_file(`components/${args.name}.ree`);
				if (!existsSync(component_path)) { throw new Error(`Component "${args.name}" not found`); }
				const source = await file(component_path).text();
				return text_content(source);
			},
		},
		{
			name: "read_template_file",
			description: "Read a .ree template file under the main app, platform/, or components/.",
			inputSchema: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Project-relative path under the main app, platform/, or components/ (e.g. 'apps/main/home/index.ree').",
					},
				},
				required: ["path"],
			},
			handler: async (args) => {
				const template_path = resolve_template_file(args.path);
				if (!existsSync(template_path)) { throw new Error(`Template file not found: ${args.path}`); }
				const source = await file(template_path).text();
				return text_content(source);
			},
		},
		{
			name: "render_template_file",
			description: "Execute and render a .ree template under the main app, platform/, or components/. Requires MCP_ENABLE_TEMPLATE_RENDER=true.",
			inputSchema: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Project-relative path under the main app, platform/, or components/ (e.g. 'apps/main/home/index.ree').",
					},
					data: {
						type: "object",
						description: "Data object to pass to the template",
						additionalProperties: true,
					},
				},
				required: ["path"],
			},
			handler: async (args) => {
				assert_template_rendering_enabled();
				const template_path = resolve_template_file(args.path);
				if (!existsSync(template_path)) { throw new Error(`Template file not found: ${args.path}`); }
				const template = await file(template_path).text();
				const html = await engine.render_string(template, default_template_data(args.data || {}));
				return text_content(html);
			},
		},
	];
}
