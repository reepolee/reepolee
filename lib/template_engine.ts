/**
 * File-Based Template Engine - Inspired by Eta.js & Svelte
 * Pure vanilla JavaScript implementation with layouts and partials
 * Optimized for Bun runtime
 *
 * Tags and directives:
 * - {= expr }     -> escaped output
 * - {~ expr }     -> unescaped output
 * - {{ ... }}     -> raw JS (double braces)
 * - {#layout('path', props?) }
 * - {#include('path', props?) }    // treated as HTML block; not escaped as a whole
 * - {#each list as item[, index][, key] } ... {:else} ... {/each}
 * - {#if condition }              ... {:else} ... {/if}
 * - {#with expr }                 ... {/with}
 * - .identifier             -> spread shorthand: {~ key_values(identifier)} (unescaped)
 * - <tag-name>...</tag-name>   -> custom HTML element shorthand (ReeTag)
 * (any tag whose name has at least one hyphen;
 * attributes on the tag are passed under props.attributes;
 * pre-processor emits a NUL marker that compile_to_code
 * resolves into a __rtInclude call)
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { default_locale } from "$config/supported_locales";
import type { RouteModuleMount } from "$lib/route_module";
import { file, write } from "bun";

import { compile_to_code as _compile_to_code } from "./template/compiler";
import { preprocess_template } from "./template/custom_elements";
import { include_resolved_handler, type IncludeHandlerDeps } from "./template/include_handler";
import { resolve_include } from "./template/include_resolver";
import type { CompiledFn } from "./template/types";

type Config = {
	views?: string;
	cache?: boolean;
	auto_escape?: boolean;
	ext?: string;
	route_module_mounts?: RouteModuleMount[];
};

class TemplateEngine {
	views_dir: string;
	cache: boolean;
	auto_escape: boolean;
	ext: string;
	compiled_cache: Record<string, CompiledFn>;
	route_module_mounts: Map<string, string>;

	constructor(config: Config = {}) {
		this.views_dir = config.views || "./views";
		// cache only in production unless explicitly set
		this.cache = typeof config.cache === "boolean" ? config.cache : Bun.env.NODE_ENV === "production";
		this.auto_escape = config.auto_escape !== false;
		this.ext = config.ext || ".ree";
		this.compiled_cache = {};
		this.route_module_mounts = new Map();
		const route_module_mounts = config.route_module_mounts ?? [];
		for (const mount of route_module_mounts) {
			this.route_module_mounts.set(mount.module_code, mount.module_root);
		}
	}

	private resolve_template_file(name: string): string {
		const normalized_name = name.replaceAll("\\", "/");
		const slash_index = normalized_name.indexOf("/");
		const module_code = slash_index === -1 ? normalized_name : normalized_name.slice(0, slash_index);
		const module_root = this.route_module_mounts.get(module_code);
		if (!module_root) return join(this.views_dir, normalized_name + this.ext);

		const relative_name = slash_index === -1 ? "" : normalized_name.slice(slash_index + 1);
		const file_path = resolve(join(module_root, relative_name + this.ext));
		const relative_path = relative(module_root, file_path);
		const parent_prefix = `..${sep}`;
		const is_outside = relative_path === ".." || relative_path.startsWith(parent_prefix) || isAbsolute(relative_path);
		if (is_outside) {
			throw new Error(`Template path escapes mounted route module "${module_code}": ${name}`);
		}

		return file_path;
	}

	// Load template text from file
	async load_template(name: string): Promise<string> {
		const file_path = this.resolve_template_file(name);
		if (!existsSync(file_path)) { throw new Error(`Template file not found: ${file_path}`); }
		const f = file(file_path);
		return await f.text();
	}

	/**
	 * Load template with locale-specific fallback chain (lowercase filenames):
	 * {name}.{locale}.ree -> {name}.{default_locale}.ree -> {name}.ree
	 * e.g. home.sl-si.ree -> home.en-us.ree -> home.ree
	 * Returns the content and the resolved name (for cache key usage).
	 */
	async load_localized(name: string, locale: string): Promise<{ content: string; resolved_name: string; }> {
		const candidates = [`${name}.${locale.toLowerCase()}`, `${name}.${default_locale.toLowerCase()}`, name];
		for (const candidate of candidates) {
			const file_path = this.resolve_template_file(candidate);
			if (existsSync(file_path)) {
				const f = file(file_path);
				return { content: await f.text(), resolved_name: candidate };
			}
		}
		throw new Error(`Template not found: ${name} (tried: ${candidates.map((c) => c + this.ext).join(", ")})`);
	}

	/**
	 * Internal: include with resolution relative to current template.
	 * Delegates to the extracted handler in include_handler.ts.
	 */
	private async include_resolved(current_name: string, include_name: string, props: Record<string, any>): Promise<string> {
		const deps: IncludeHandlerDeps = {
			resolve_include: (c, i) => resolve_include(c, i, this.views_dir, this.ext),
			render: (n, p) => this.render(n, p),
			compile: (t) => this.compile(t),
			include: (n, p) => this.include(n, p),
			auto_escape: this.auto_escape,
			escape: (s) => this.escape(s),
			ext: this.ext,
		};
		return include_resolved_handler(deps, current_name, include_name, props);
	}

	/**
	 * Compile template string to async function
	 * Supports tags/directives:
	 * - {= expr }    (escaped)
	 * - {~ expr }    (unescaped)
	 * - {{ ... }}    (raw JS - double braces)
	 * - {#layout('path', props?) }
	 * - {#include('path', props?) }  (treated as HTML block; not escaped as a whole)
	 * - {#each list as item[, index][, key] } ... {:else} ... {/each}		 *  - {#if condition } ... {:else} ... {/if}
	 * - {#with expr } ... {/with}
	 * - <tag-name>...</tag-name>     (ReeTag; includes /components/tag-name.ree with props)
	 */
	compile(template: string) {
		const { fn } = this.compile_to_code(template);
		return fn;
	}

	/**
	 * Compile and return both the generated JavaScript source code and the
	 * compiled async render function. Useful for debugging and the MCP
	 * server's compile_template tool.
	 */
	compile_to_code(template: string): { code: string; fn: CompiledFn; } {
		// Pre-process: custom elements, HTML comments, spread shorthand
		const { template: processed_template, slot_fns } = preprocess_template(template, this.views_dir, this.ext, (content) => this.compile(content));

		// Compile: template directives -> async render function
		return _compile_to_code(processed_template, slot_fns);
	}

	// HTML escape (single-pass)
	escape(str: any): string {
		if (str == null) return "";
		const s = String(str);
		return s.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	}

	async include(name: string, props: Record<string, any>): Promise<string> {
		// layout() uses include from views root semantics
		return await this.render(name, props);
	}

	async render(name: string, props: Record<string, any> = {}): Promise<string> {
		const current_name = name; // used by relative includes within this template
		const lang = props?.lang;

		// Resolve localized variant if language is available:
		// {name}.{lang}.ree -> {name}.{default_locale}.ree -> {name}.ree
		let resolved_name = name;
		let template: string;
		if (lang) {
			const result = await this.load_localized(name, lang);
			template = result.content;
			resolved_name = result.resolved_name;
		} else {
			template = await this.load_template(name);
		}

		if (this.cache && this.compiled_cache[resolved_name]) {
			const compiled_fn = this.compiled_cache[resolved_name];
			const bound_include = this.include.bind(this);
			const rt_include = this.include_resolved.bind(this, current_name);
			const escape = this.auto_escape ? this.escape.bind(this) : (s: any) => String(s ?? "");
			return await (compiled_fn as any)(props, escape, bound_include, rt_include, current_name);
		}

		const compiled_fn = this.compile(template);

		if (this.cache) { this.compiled_cache[resolved_name] = compiled_fn; }

		const bound_include = this.include.bind(this);
		const rt_include = this.include_resolved.bind(this, current_name);
		const escape = this.auto_escape ? this.escape.bind(this) : (s: any) => String(s ?? "");

		return await (compiled_fn as any)(props, escape, bound_include, rt_include, current_name);
	}

	async render_string(template_string: string, props: Record<string, any> = {}): Promise<string> {
		const compiled_fn = this.compile(template_string);
		const current_name = ""; // treat render_string as views-root
		const bound_include = this.include.bind(this);
		const rt_include = this.include_resolved.bind(this, current_name);
		const escape = this.auto_escape ? this.escape.bind(this) : (s: any) => String(s ?? "");
		return await (compiled_fn as any)(props, escape, bound_include, rt_include, current_name);
	}

	clear_cache(): void { this.compiled_cache = {}; }

	async write_output(file_path: string, content: string): Promise<void> {
		const dir = dirname(file_path);
		if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
		await write(file_path, content);
	}
}

export default TemplateEngine;
