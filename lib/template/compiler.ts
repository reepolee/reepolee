/**
 * Template Compiler - extracted from TemplateEngine.compile().
 *
 * Takes a preprocessed template string (with custom elements, comments, and
 * spread shorthands already resolved) and compiles it into an async function
 * that renders HTML at runtime.
 *
 * Handles:
 * - {= expr }        escaped output
 * - {~ expr }        unescaped output
 * - {{ ... }}        raw JS (double braces)
 * - {#layout(...)}   layout wrapping
 * - {#include(...)}  partial includes
 * - {#each} / {:else} / {/each} iteration
 * - {#if} / {:else} / {/if} conditionals
 * - {#with} / {/with} scope blocks
 * - Block stack state machine for nested structures
 * - new Function() code generation
 */

import { DEFAULT_HELPER_NAMES } from "./helper_names";
import { build_translation_resolve_expr } from "./translation_path";
import type { CompiledFn } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlockEntry {
	type: "each" | "if" | "with";
	id?: number;
	has_else: boolean;
}

interface LayoutInfo {
	name: string;
	data: string;
}

interface CompileState {
	block_stack: BlockEntry[];
	each_counter: number;
}

// ---------------------------------------------------------------------------
// Directive call parser
// ---------------------------------------------------------------------------

/**
 * Parse a directive call string like:
 * layout('path', { expr })
 * include('path', { expr })
 *
 * Returns the first argument (string name) and the optional second argument
 * (a JS expression for data). Returns null on parse failure.
 */
function parse_call(s: string): { name: string; data_expr: string; } | null {
	const open_paren_idx = s.indexOf("(");
	if (open_paren_idx < 0) return null;

	let i = open_paren_idx + 1;
	const n = s.length;

	// Read first arg: quoted string
	while (i < n && /\s/.test(s[i])) i++;
	if (i >= n) return null;

	const quote = s[i];
	if (quote !== "'" && quote !== "\"" && quote !== "`") return null;
	i++; // after opening quote

	let name = "";
	let escaped = false;
	while (i < n) {
		const ch = s[i++];
		if (escaped) {
			name += ch;
			escaped = false;
		} else if (ch === "\\") {
			escaped = true;
		} else if (ch === quote) {
			break;
		} else {
			name += ch;
		}
	}
	if (i > n) return null;

	// Skip spaces
	while (i < n && /\s/.test(s[i])) i++;

	// Optional second arg
	if (i < n && s[i] === ",") {
		i++; // skip comma
		while (i < n && /\s/.test(s[i])) i++;
		let depth_paren = 0, depth_brace = 0, depth_bracket = 0;
		let in_str: string | null = null;
		let esc = false;
		let expr = "";
		while (i < n) {
			const ch = s[i++];
			expr += ch;

			if (in_str) {
				if (esc) {
					esc = false;
				} else if (ch === "\\") {
					esc = true;
				} else if (ch === in_str) {
					in_str = null;
				}
				continue;
			}

			if (ch === "\"" || ch === "'" || ch === "`") {
				in_str = ch;
				continue;
			}

			if (ch === "(") depth_paren++; else if (ch === ")") {
				if (depth_paren === 0 && depth_brace === 0 && depth_bracket === 0) {
					// This ')' closes the directive
					expr = expr.slice(0, -1); // drop this ')'
					const data_expr = expr.trim() || "{}";
					return { name, data_expr };
				}
				depth_paren--;
			} else if (ch === "{") depth_brace++; else if (ch === "}") depth_brace--; else if (ch === "[") depth_bracket++; else if (ch === "]") depth_bracket--;
		}
		return null; // no closing paren
	} else {
		// No second arg: expect ')'
		while (i < n && /\s/.test(s[i])) i++;
		if (i >= n || s[i] !== ")") return null;
		return { name, data_expr: "{}" };
	}
}

/**
 * Scan a prefix tag ({= ...}, {#layout(...)}, etc.) starting at the opening
 * brace, balancing nested braces and respecting string literals. The main
 * loop's non-greedy regex stops at the first "}", which truncates tags whose
 * content contains an object literal, e.g. {#layout('x', { title: 'y' })}.
 * Returns the full inner content (after the prefix char) and the index just
 * past the closing brace, or null if no balanced close exists.
 */
function scan_balanced_tag(s: string, start: number): { content: string; end: number; } | null {
	// s[start] === "{", s[start + 1] is the prefix char
	let depth = 1;
	let in_str: string | null = null;
	let esc = false;
	let i = start + 2;
	const n = s.length;
	while (i < n) {
		const ch = s[i];
		if (in_str) {
			if (esc) {
				esc = false;
			} else if (ch === "\\") {
				esc = true;
			} else if (ch === in_str) {
				in_str = null;
			}
		} else if (ch === "\"" || ch === "'" || ch === "`") {
			in_str = ch;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const content = s.slice(start + 2, i);
				return { content, end: i + 1 };
			}
		}
		i++;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Individual token handler functions
// ---------------------------------------------------------------------------

/**
 * Emit literal text between template tags.
 */
function emit_text(text: string): string { return `__output += ${JSON.stringify(text)};\n`; }

/**
 * Emit raw JS code block from {{ ... }}.
 */
function emit_code_block(raw_js: string): string { return `${raw_js}\n`; }

/**
 * Handle {#layout(...)} - stores layout info for post-processing.
 * Returns the LayoutInfo or null if parsing fails.
 */
function handle_layout(trimmed_call: string): LayoutInfo {
	const parsed = parse_call(trimmed_call);
	if (!parsed) { throw new Error(`Invalid layout syntax: "{#${trimmed_call}}". Expected {#layout('path'[, data])}`); }
	return { name: parsed.name, data: parsed.data_expr || "{}" };
}

/**
 * Handle {#include(...)} - emits an include call.
 */
function emit_include(trimmed_call: string): string {
	const parsed = parse_call(trimmed_call);
	if (!parsed) { throw new Error(`Invalid include syntax: "{#${trimmed_call}}". Expected {#include('path'[, data])}`); }
	const partial_name = parsed.name;
	const partial_data = parsed.data_expr || "{}";
	return `__output += await __rtInclude(${JSON.stringify(partial_name)}, Object.assign({}, props, ${partial_data}));\n`;
}

/**
 * Handle {#each ... as ...} - emits the JS for loop setup.
 */
function emit_each_open(trimmed_content: string, state: CompileState): string {
	const each_match = trimmed_content.match(/^each\s+(.*?)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*$/);
	if (!each_match) { throw new Error(`Invalid #each syntax: "{#each ${trimmed_content}}". Expected "{#each <list_expr> as <item>[, index][, key] }"`); }
	const list_expr = each_match[1];
	const item_var = each_match[2];
	const index_var = each_match[3];
	const key_var = each_match[4];

	const id = state.each_counter++;
	state.block_stack.push({ type: "each", id, has_else: false });

	return `\n{\n  const __src_${id} = (${list_expr});\n  const __isArr_${id} = Array.isArray(__src_${id});\n  const __keys_${id} = __isArr_${id}\n    ? Array.from({ length: __src_${id} ? __src_${id}.length : 0 }, (_, i) => i)\n    : (__src_${id} && typeof __src_${id} === "object" ? Object.keys(__src_${id}) : []);\n\n  if (__keys_${id}.length > 0) {\n    for (let __i_${id} = 0; __i_${id} < __keys_${id}.length; __i_${id}++) {\n      const __k_${id} = __keys_${id}[__i_${id}];\n      const ${item_var} = __src_${id} ? __src_${id}[__k_${id}] : undefined;\n      ${index_var ? `const ${index_var} = __i_${id};` : ""}\n      ${key_var ? `const ${key_var} = __k_${id};` : ""}\n`;
}

/**
 * Handle {#with ...} - emits the JS with() block setup.
 */
function emit_with_open(trimmed_content: string, state: CompileState): string {
	const expr = trimmed_content.replace(/^with\b/, "").trim();
	if (!expr) { throw new Error(`Invalid #with syntax: "{#with ${trimmed_content}}". Expected "{#with <expr> }"`); }
	const id = state.each_counter++;
	state.block_stack.push({ type: "with", id, has_else: false });
	return `\n{\n  const __with$${id} = (${expr});\n  with (__with$${id}) {\n`;
}

/**
 * Handle {#if ...} - emits the JS if() block setup.
 */
function emit_if_open(trimmed_content: string, state: CompileState): string {
	const cond = trimmed_content.replace(/^if\b/, "").trim();
	if (!cond) { throw new Error(`Invalid #if syntax: "{#if ${trimmed_content}}". Expected "{#if <condition> }"`); }
	state.block_stack.push({ type: "if", has_else: false });
	return `\n{\n  let __if_result;\n  try { __if_result = (${cond}); } catch (__if_e) { __if_result = undefined; }\n  if (__if_result) {\n`;
}

/**
 * Handle {:else} - emits the else branch code.
 */
function emit_else(state: CompileState): string {
	if (state.block_stack.length === 0) { throw new Error("Unexpected {:else} without an open {#if} or {#each} block"); }
	if (state.block_stack[state.block_stack.length - 1].type === "with") { throw new Error("{:else} is not allowed inside {#with} blocks"); }
	const current = state.block_stack[state.block_stack.length - 1]!;
	if (current.has_else) { throw new Error("Multiple {:else} in the same block are not allowed"); }
	current.has_else = true;

	if (current.type === "each") {
		return `

    }
  } else {
`;
	} else if (current.type === "if") {
		return `
  } else {
`;
	}
	return "";
}

/**
 * Handle {/each} - closes an each block.
 */
function emit_close_each(state: CompileState): string {
	if (state.block_stack.length === 0 || state.block_stack[state.block_stack.length - 1].type !== "each") { throw new Error("Unexpected {/each} without a matching {#each}"); }
	const blk = state.block_stack.pop()!;
	if (blk.has_else) {
		return `
  }
}
`;
	} else {
		return `
    }
  }
}
`;
	}
}

/**
 * Handle {/with} - closes a with block.
 */
function emit_close_with(state: CompileState): string {
	if (state.block_stack.length === 0 || state.block_stack[state.block_stack.length - 1].type !== "with") { throw new Error("Unexpected {/with} without a matching {#with}"); }
	state.block_stack.pop();
	return `
  }
}
`;
}

/**
 * Handle {/if} - closes an if block.
 */
function emit_close_if(state: CompileState): string {
	if (state.block_stack.length === 0 || state.block_stack[state.block_stack.length - 1].type !== "if") { throw new Error("Unexpected {/if} without a matching {#if}"); }
	state.block_stack.pop();
	return `
  }
}
`;
}

/**
 * Handle {= expr} or {~ expr} - escaped/unescaped output expression.
 * Arbitrary JS. undefined/null renders as "" (via __escape); a genuinely
 * broken expression throws. For translation lookups with a missing-key
 * safety net, use {_ path} / {- path} / {@ path} instead (see
 * emit_translation_lookup); {@ } additionally renders the value as markdown.
 */
function emit_expression(prefix: string, content: string): string {
	switch (prefix) {
		case "=":
			return `__output += __escape(${content});\n`;
		case "~":
			return `\n{\n\tconst __tmp = (${content});\n\t__output += (typeof __tmp === "function" ? __tmp() : __tmp);\n}\n`;
		default:
			return `${content}\n`;
	}
}

/**
 * Handle {_ path} or {- path} - translation lookup, escaped/unescaped.
 * `path` is a restricted property path (e.g. "labels.text_input" or
 * "selectors?.[\"0\"]" for non-identifier keys), always resolved against
 * props.translations via a safe compile-time property walk - never
 * eval-and-catch. On a missing key, or when props.translations itself is
 * absent (legitimate mid-scaffolding, before translation keys are wired up),
 * renders `{last_segment}` instead of throwing or silently rendering empty -
 * same marker convention as mark_missing_from() in lib/i18n.ts and
 * nav_label() in template_helpers.ts. Path grammar and resolve expression
 * live in translation_path.ts, shared with ReeTag attribute parsing.
 */
function emit_translation_lookup(prefix: string, content: string): string {
	const resolve_expr = build_translation_resolve_expr(content, `Invalid {${prefix} ${content}} syntax`);

	switch (prefix) {
		case "_":
			return `__output += __escape(${resolve_expr});\n`;
		case "-":
			return `\n{\n\tconst __tmp = ${resolve_expr};\n\t__output += (typeof __tmp === "function" ? __tmp() : __tmp);\n}\n`;
		case "@":
			// Translation lookup rendered through markdown to HTML. A missing key
			// resolves to the "{marker}" literal, which markdown wraps in a <p>.
			return `\n{\n\tconst __md_src = ${resolve_expr};\n\t__output += (__md_src == null || __md_src === "" ? "" : Bun.markdown.html(String(__md_src), { noHtmlBlocks: true, noHtmlSpans: true }));\n}\n`;
		default:
			throw new Error(`Unknown translation lookup prefix "${prefix}"`);
	}
}

// ---------------------------------------------------------------------------
// Main compiler entry points
// ---------------------------------------------------------------------------

/**
 * Compile a preprocessed template string into an async render function.
 *
 * @param processed_template - Template string after custom element, comment,
 * and spread shorthand preprocessing.
 * @param slot_fns           - Compiled slot functions for custom elements.
 * @returns A CompiledFn that renders the template to HTML at runtime.
 */
export function compile_template(processed_template: string, slot_fns: CompiledFn[]): CompiledFn {
	const { fn } = compile_to_code(processed_template, slot_fns);
	return fn;
}

/**
 * Compile and return both the generated JS code and the compiled function.
 * Useful for debugging, introspection, and the MCP server's compile_template tool.
 */
export function compile_to_code(processed_template: string, slot_fns: CompiledFn[]): { code: string; fn: CompiledFn; } {
	// Resolve ReeTag markers emitted by the pre-processor. Each marker encodes
	// the component tag name, slot id, and props object. We translate them to
	// raw-JS markers (\u0000J\u0000...\u0000) that the main loop recognizes and
	// emits via emit_code_block. Two-stage because the main loop's
	// balanced-brace-agnostic regexes can't safely parse these data payloads.
	// eslint-disable-next-line no-control-regex
	processed_template = processed_template.replace(/\u0000R\u0000([^\u0000]+)\u0000(\d+)\u0000([\s\S]*?)\u0000/g, (_match, tag_name, _slotId, props_obj) => {
		const component_path = `$components/${tag_name}`;
		const js = `__output += await __rtInclude(${JSON.stringify(component_path)}, Object.assign({}, props, ${props_obj}));\n`;
		return `\u0000J\u0000${js}\u0000\u0000`;
	});

	let code = "let __output = \"\";\n";
	code += "const { user, is_dev, lang, csrf_token, helpers = {} } = props;\n";
	let layout_result: LayoutInfo | null = null;

	// eslint-disable-next-line no-control-regex
	const combined_pattern = /\{\{([\s\S]*?)\}\}|\{([~=#:/_@-])\s*([\s\S]*?)\}|\u0000J\u0000([\s\S]*?)\u0000\u0000/g;

	const state: CompileState = { block_stack: [], each_counter: 0 };

	let last_index = 0;
	let match: RegExpExecArray | null;

	while ((match = combined_pattern.exec(processed_template)) !== null) {
		const index = match.index;

		// Emit literal text between tags
		if (index > last_index) {
			const text = processed_template.slice(last_index, index);
			code += emit_text(text);
		}

		if (match[1] !== undefined) {
			// {{ ... }} - raw JS
			code += emit_code_block(match[1].trim());
		} else if (match[4] !== undefined) {
			// \u0000J\u0000...\u0000\u0000 - ReeTag-resolved raw JS statement
			code += match[4];
		} else if (match[2] !== undefined) {
			// {prefix ... } - directive or output with explicit prefix
			const prefix = match[2];
			let raw_content = match[3]!;

			// The non-greedy regex stops at the first "}", truncating tags whose
			// content contains braces (object literals in layout/include data,
			// {= {a:1}.a }, etc.). Rescan with brace balancing and extend the
			// match when the true closing brace is further out.
			const balanced = scan_balanced_tag(processed_template, index);
			if (balanced && balanced.end > combined_pattern.lastIndex) {
				raw_content = balanced.content;
				combined_pattern.lastIndex = balanced.end;
			}

			const trimmed_content = raw_content.trim();

			if (trimmed_content.startsWith("layout(") || trimmed_content.startsWith("include(")) {
				const paren_idx = trimmed_content.indexOf("(");
				const directive_name = trimmed_content.slice(0, paren_idx);
				const directive_content = trimmed_content.slice(paren_idx);
				const trimmed_call = `${directive_name}${directive_content}`;

				if (directive_name === "layout") {
					layout_result = handle_layout(trimmed_call);
				} else if (directive_name === "include") {
					code += emit_include(trimmed_call);
				}
			} else if (prefix === "#" && trimmed_content.startsWith("each")) {
				code += emit_each_open(trimmed_content, state);
			} else if (prefix === "#" && /^with\b/.test(trimmed_content)) {
				code += emit_with_open(trimmed_content, state);
			} else if (prefix === "#" && /^if\b/.test(trimmed_content)) {
				code += emit_if_open(trimmed_content, state);
			} else if (prefix === ":" && trimmed_content === "else") {
				code += emit_else(state);
			} else if (prefix === "/" && trimmed_content === "each") {
				code += emit_close_each(state);
			} else if (prefix === "/" && trimmed_content === "with") {
				code += emit_close_with(state);
			} else if (prefix === "/" && trimmed_content === "if") {
				code += emit_close_if(state);
			} else if (prefix === "_" || prefix === "-" || prefix === "@") {
				code += emit_translation_lookup(prefix, trimmed_content);
			} else {
				code += emit_expression(prefix, trimmed_content);
			}
		}

		last_index = combined_pattern.lastIndex;
	}

	// Trailing literal text
	if (last_index < processed_template.length) {
		const text = processed_template.slice(last_index);
		code += emit_text(text);
	}

	// Ensure no unclosed blocks
	if (state.block_stack.length > 0) {
		const openTypes = state.block_stack.map((b) => b.type).join(", ");
		throw new Error(`Unclosed block(s): ${openTypes}`);
	}

	// Wrap layout if present
	if (layout_result) {
		code = `\n${code}\nconst __body = __output;\nconst __layoutData = Object.assign({}, props, ${layout_result.data}, { body: __body });\n__output = await __include(${JSON.stringify(
			layout_result.name
		)}, __layoutData);\n`;
	}

	code += "return __output;";

	// Build async function
	let fn;
	try {
		// Bind the built-in helpers as bare identifiers via a static destructure.
		// The previous per-render eval loop not only cost ~20 evals per render -
		// the presence of eval() deoptimized the entire compiled function.
		// Custom helpers beyond DEFAULT_HELPER_NAMES stay reachable as helpers.<name>.
		const helper_vars = `const { ${DEFAULT_HELPER_NAMES.join(", ")} } = (props?.helpers || {});`;

		fn = new Function("props", "__escape", "__include", "__rtInclude", "__currentName", "__slot_fns", `return (async () => {
const __run_slot = async (id, ...args) => {
	const fn = __slot_fns?.[id];
	return fn ? await fn(...args) : "";
};
${helper_vars}
${code}
})()`) as (props: Record<string, any>, __escape: (x: any) => string, __include: (n: string, d: Record<string, any>) => Promise<string>, __rtInclude: (n: string, d: Record<string, any>) => Promise<string>, __currentName: string) => Promise<string>;
	} catch (err) {
		console.error("=== Template Compilation Error ===");
		console.error("Generated code:");
		console.error(code);
		console.error("==================================");
		const err_msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Template compilation failed: ${err_msg}`);
	}

	// Wrap to bind runtime helpers
	const compiled = async (props: Record<string, any>, escape: (x: any) => string, bound_include: (n: string, d: Record<string, any>) => Promise<string>, rt_include: (n: string, d: Record<string, any>) => Promise<string>, current_name: string) => {
		return await fn(props, escape, bound_include, rt_include, current_name, slot_fns);
	};

	return { code, fn: compiled as unknown as CompiledFn };
}
