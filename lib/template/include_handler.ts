/**
 * Include handler - extracted from TemplateEngine.include_resolved().
 *
 * Handles runtime include dispatch:
 * - For templates (kind === "template"): delegates to render()
 * - For raw .ree file paths: loads and compiles with language variant fallback
 * - For non-ree raw files: reads and returns as-is
 */

import { extname } from "node:path";

import { file } from "bun";

import type { CompiledFn, ResolveResult } from "./types";

// async file existence check - avoids sync fs calls in the render path
async function file_exists(p: string): Promise<boolean> { return await file(p).exists(); }

/**
 * Dependencies needed from the TemplateEngine instance.
 */
export interface IncludeHandlerDeps {
	resolve_include(current_name: string, include_name: string): ResolveResult;
	render(name: string, props: Record<string, any>): Promise<string>;
	compile(template: string): CompiledFn;
	include(name: string, props: Record<string, any>): Promise<string>;
	auto_escape: boolean;
	escape(s: any): string;
	ext: string;
	/** Host fallback locale, lowercased, for the raw .ree variant chain. */
	default_locale: string;
	/** Precompiled lookup: compiled fn for an absolute file path (prod). */
	compiled_for_path?: (file_path: string) => CompiledFn | undefined;
	/** Precompiled locale-variant lookup for raw .ree includes. */
	raw_variant?: (file_path: string, locale: string) => string | null;
}

/**
 * Resolve and execute an include directive at render time.
 *
 * Routes through the dependency-injected TemplateEngine methods to
 * avoid circular module dependencies and keep the function pure.
 */
export async function include_resolved_handler(deps: IncludeHandlerDeps, current_name: string, include_name: string, props: Record<string, any>): Promise<string> {
	const info = deps.resolve_include(current_name, include_name);
	if (info.kind === "template") {
		return await deps.render(info.template_name!, props);
	} else {
		const p = info.file_path!;

		// Check if it's a .ree template file that should be compiled
		if (extname(p) === deps.ext) {
			// Try locale variants for raw .ree paths (e.g., components), lowercase filenames:
			// {dir}/{base}.{locale}.ree -> {dir}/{base}.{default_locale}.ree -> {dir}/{base}.ree
			// Precompiled variant index first (zero fs), then the disk candidates.
			let resolved_file_path = p;
			const include_locale = props?.locale;
			if (include_locale) {
				const loc = String(include_locale).toLowerCase();
				const precompiled = deps.raw_variant?.(p, loc) ?? deps.raw_variant?.(p, deps.default_locale);
				if (precompiled) {
					resolved_file_path = precompiled;
				} else {
					const base_name = p.slice(0, -deps.ext.length);
					const lang_candidates = [`${base_name}.${loc}${deps.ext}`, `${base_name}.${deps.default_locale}${deps.ext}`, p];
					for (const lc of lang_candidates) {
						if (await file_exists(lc)) {
							resolved_file_path = lc;
							break;
						}
					}
				}
			}

			// Prod fast path: precompiled fn -> no read + no recompile per render.
			const compiled_fn = deps.compiled_for_path?.(resolved_file_path);
			if (compiled_fn) {
				const bound_include = deps.include;
				const rt_include = (name: string, data: Record<string, any>) => include_resolved_handler(deps, include_name, name, data);
				const escape = deps.auto_escape ? deps.escape : (s: any) => String(s ?? "");
				return await (compiled_fn as any)(props, escape, bound_include, rt_include, include_name);
			}

			// Fallback: read + compile (dev hot reload, or files not precompiled).
			if (!(await file_exists(resolved_file_path))) { throw new Error(`Included file not found: ${resolved_file_path}`); }
			const template_content = await file(resolved_file_path).text();
			const compiled = deps.compile(template_content);
			const bound_include = deps.include;
			const rt_include = (name: string, data: Record<string, any>) => include_resolved_handler(deps, include_name, name, data);
			const escape = deps.auto_escape ? deps.escape : (s: any) => String(s ?? "");
			return await (compiled as any)(props, escape, bound_include, rt_include, include_name);
		} else {
			// Raw file injected unescaped
			if (!(await file_exists(p))) { throw new Error(`Included file not found: ${p}`); }
			const f = file(p);
			return await f.text();
		}
	}
}
