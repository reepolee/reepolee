import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RouteModuleMount } from "$lib/route_module";
import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";
import { create_template_helpers } from "$lib/template_helpers";
import { MAIN_APP } from "$config/paths";

const TE = (await import("./template_engine")).default;
const { precompile_templates } = await import("./template/precompile");

// Engines under test get an explicit locale set rather than the app config, so
// locale-variant assertions stay stable regardless of which locales the app
// ships or what another test file's module mock installs (mock.module is
// global). Kept equal to the shipped config's shape so tests exercise the same
// variant-suffix rule production does.
const TEST_LOCALES = ["en-us", "sl-si"] as const;
const TEST_DEFAULT_LOCALE = "en-us";

function make_engine(views: string, route_module_mounts: RouteModuleMount[] = []) {
	return new TE({ views, cache: false, ext: ".ree", route_module_mounts, locales: TEST_LOCALES, default_locale: TEST_DEFAULT_LOCALE, helper_names: DEFAULT_HELPER_NAMES });
}

// File-based renders run in dev mode here (cache: false), where the engine
// stamps block tags with data-ree="<file>:<line>" for the inspector
// (lib/inspector_stamp.ts). Tests asserting on exact markup strip the stamp so
// they assert the template engine's own output; stamping has its own tests.
function without_stamps(html: string): string {
	return html.replace(/ data-ree="[^"]*"/g, "");
}

function with_temp_dir(fn: (dir: string, engine: any) => Promise<void>) {
	return async () => {
		const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
		const dir = join(project_root, "views");
		mkdirSync(dir);
		try {
			await fn(dir, make_engine(dir));
		} finally {
			rmSync(project_root, { recursive: true, force: true });
		}
	};
}

describe("TemplateEngine", () => {
	describe("render_string - inline compilation", () => {
		test("interpolates escaped output", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("Hello {= props.name }!", { name: "World" });
			expect(result).toBe("Hello World!");
		});

		test("escapes HTML in expressions", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{= '<script>alert(1)</script>' }");
			expect(result).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
		});

		test("unescaped output with {~ ... }", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{~ '<b>bold</b>' }");
			expect(result).toBe("<b>bold</b>");
		});

		test("{@ path } renders a translation value through markdown", async () => {
			const engine = make_engine("/tmp");
			const props = { translations: { ui: { body: "# Title\n\n**bold** text" } } };
			const result = await engine.render_string("{@ ui.body }", props);
			expect(result).toContain("<h1>Title</h1>");
			expect(result).toContain("<strong>bold</strong>");
		});

		test("{@ path } escapes raw HTML in markdown translations", async () => {
			const engine = make_engine("/tmp");
			const props = { translations: { ui: { body: "<script>alert(1)</script>" } } };
			const result = await engine.render_string("{@ ui.body }", props);
			expect(result).not.toContain("<script>");
			expect(result).toContain("&lt;script&gt;");
		});

		test("{@ path } on a missing key markdown-renders the {marker}", async () => {
			const engine = make_engine("/tmp");
			// Miss resolves to the "{body}" marker literal, which markdown wraps in a <p>.
			const result = await engine.render_string("{@ ui.body }", { translations: {} });
			expect(result).toContain("{body}");
		});

		test("{@ path } rejects an arbitrary expression (translation path only)", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{@ props.x + 1 }", { x: 1 })).rejects.toThrow();
		});

		test("{@ } prefix does not clash with CSS nesting braces", async () => {
			const engine = make_engine("/tmp");
			// {&:hover{...}} must pass through as literal text, not a markdown tag.
			const css = "<style>a{&:hover{color:red}}</style>";
			expect(await engine.render_string(css)).toBe(css);
		});

		test("raw JS with {{ ... }}", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{{ const x = 10; }}val: {= x }");
			expect(result).toBe("val: 10");
		});

		test("literal ...identifier text is preserved", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("before ...rest after");
			expect(result).toBe("before ...rest after");
		});

		test("client-side script blocks preserve JS spread syntax", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("<script>const attrs = { ...props.attributes };</script>");
			expect(result).toBe("<script>const attrs = { ...props.attributes };</script>");
		});
	});

	describe("{_ path} / {- path} - translation lookup", () => {
		test("resolves a top-level path", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ ui.title}", { translations: { ui: { title: "Kitchen Sink" } } });
			expect(result).toBe("Kitchen Sink");
		});

		test("resolves a nested path", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ labels.text_input}", { translations: { labels: { text_input: "Text Input" } } });
			expect(result).toBe("Text Input");
		});

		test("HTML-escapes the resolved value", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ ui.title}", { translations: { ui: { title: "<script>x</script>" } } });
			expect(result).toBe("&lt;script&gt;x&lt;/script&gt;");
		});

		test("{- } does not HTML-escape", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{- ui.body}", { translations: { ui: { body: "<b>bold</b>" } } });
			expect(result).toBe("<b>bold</b>");
		});

		test("renders {last_segment} when the leaf key is missing", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ labels.text_input}", { translations: { labels: {} } });
			expect(result).toBe("{text_input}");
		});

		test("renders {last_segment} when an intermediate object is missing", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ descriptions.card}", { translations: {} });
			expect(result).toBe("{card}");
		});

		test("renders {last_segment} when props.translations is absent entirely", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ ui.title}", {});
			expect(result).toBe("{title}");
		});

		test("does not decorate real data outside props.translations", async () => {
			const engine = make_engine("/tmp");
			// {= } is unaffected by the {_ } safety net - null/undefined stays "".
			const result = await engine.render_string("{= props.user}", { user: null });
			expect(result).toBe("");
		});

		test("resolves a bracketed string key", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ selectors?.[\"0\"]}", { translations: { selectors: { "0": "No" } } });
			expect(result).toBe("No");
		});

		test("renders {last_segment} when a bracketed key is missing", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{_ selectors?.[\"0\"]}", { translations: { selectors: {} } });
			expect(result).toBe("{0}");
		});

		test("rejects arbitrary JS in the path at compile time", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{_ labels[key]}", { translations: {} })).rejects.toThrow();
		});

		test("rejects a function call in the path at compile time", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{_ labels.text_input()}", { translations: {} })).rejects.toThrow();
		});
	});

	describe("#if / {:else} / {/if}", () => {
		test("renders truthy branch", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#if props.show }shown{:else}hidden{/if}";
			expect(await engine.render_string(tmpl, { show: true })).toBe("shown");
		});

		test("renders else branch", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#if props.show }shown{:else}hidden{/if}";
			expect(await engine.render_string(tmpl, { show: false })).toBe("hidden");
		});

		test("renders if without else", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#if props.show }visible{/if}";
			expect(await engine.render_string(tmpl, { show: false })).toBe("");
		});
	});

	describe("#with / {/with}", () => {
		test("resolves property access on context object", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#with props.obj}{= name }{/with}";
			const result = await engine.render_string(tmpl, { obj: { name: "Alice" } });
			expect(result).toBe("Alice");
		});

		test("resolves nested property access", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#with props.obj}{= user.email }{/with}";
			const result = await engine.render_string(tmpl, { obj: { user: { email: "a@b.com" } } });
			expect(result).toBe("a@b.com");
		});

		test("works with unescaped output", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#with props.obj}{~ html }{/with}";
			const result = await engine.render_string(tmpl, { obj: { html: "<b>bold</b>" } });
			expect(result).toBe("<b>bold</b>");
		});

		test("nested #with blocks", async () => {
			const engine = make_engine("/tmp");
			// Inside the outer `with`, `b` resolves to props.a.b via the with scope chain
			const tmpl = "{#with props.a}{#with b}{= name }{/with}{/with}";
			const result = await engine.render_string(tmpl, { a: { b: { name: "Nested" } } });
			expect(result).toBe("Nested");
		});

		test("each inside with", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#with props.obj}{#each items as item}{= item }{/each}{/with}";
			const result = await engine.render_string(tmpl, { obj: { items: ["x", "y"] } });
			expect(result).toBe("xy");
		});

		test("throws for empty with expression", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#with }x{/with}")).rejects.toThrow("Invalid #with syntax");
		});

		test("throws for unclosed with", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#with props.x}a")).rejects.toThrow("Unclosed");
		});

		test("unclosed block error reports the preprocessed opening line", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "line one\nline two\n{#if props.x}\nunclosed from here\n";
			await expect(engine.render_string(tmpl)).rejects.toThrow("if (preprocessed line 3)");
		});

		test("unclosed block error reports each preprocessed opening line", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "l1\n{#each props.items as item}\nl3\n{#if item.x}\nl5\n";
			await expect(engine.render_string(tmpl)).rejects.toThrow(
				"each (preprocessed line 2), if (preprocessed line 4)"
			);
		});

		test("throws for unmatched /with", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{/with}")).rejects.toThrow("Unexpected {/with}");
		});

		test("throws else inside with", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#with props.x}a{:else}b{/with}")).rejects.toThrow("{:else} is not allowed");
		});

		test("with inside an each loop", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#each props.items as item}{#with item}{= value }{/with}{/each}";
			const result = await engine.render_string(tmpl, { items: [{ value: 1 }, { value: 2 }] });
			expect(result).toBe("12");
		});
	});

	describe("#switch / {#case} / {:else} / {/switch}", () => {
		test("renders the matching numeric case", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{{ const x = 100 }}{#switch x }{#case 10}<h1>It's 10</h1>{#case 100}<h1>It's 100</h1>{#case 1000}<h1>It's 1000</h1>{/switch}";
			expect(await engine.render_string(tmpl)).toBe("<h1>It's 100</h1>");
		});

		test("renders else when no case matches", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#switch props.v }{#case 10}ten{#case 100}hundred{:else}other{/switch}";
			expect(await engine.render_string(tmpl, { v: 42 })).toBe("other");
		});

		test("renders nothing when no case matches and there is no else", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "[{#switch props.v }{#case 1}one{/switch}]";
			expect(await engine.render_string(tmpl, { v: 9 })).toBe("[]");
			expect(await engine.render_string(tmpl, { v: 1 })).toBe("[one]");
		});

		test("matches string keys", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#switch props.kind }{#case \"user\"}USER{#case \"admin\"}ADMIN{:else}GUEST{/switch}";
			expect(await engine.render_string(tmpl, { kind: "user" })).toBe("USER");
			expect(await engine.render_string(tmpl, { kind: "admin" })).toBe("ADMIN");
			expect(await engine.render_string(tmpl, { kind: "x" })).toBe("GUEST");
		});

		test("case values are expressions", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#switch props.n }{#case props.a}A{#case props.b}B{:else}NONE{/switch}";
			expect(await engine.render_string(tmpl, { n: 5, a: 5, b: 9 })).toBe("A");
			expect(await engine.render_string(tmpl, { n: 9, a: 5, b: 9 })).toBe("B");
			expect(await engine.render_string(tmpl, { n: 7, a: 5, b: 9 })).toBe("NONE");
		});

		test("nests inside an each loop", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#each props.items as item}{#switch item}{#case 1}one{#case 2}two{:else}many{/switch}{/each}";
			expect(await engine.render_string(tmpl, { items: [1, 2, 3] })).toBe("onetwomany");
		});

		test("switch inside an if branch", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#if props.show}{#switch props.v}{#case \"a\"}A{:else}Z{/switch}{/if}";
			expect(await engine.render_string(tmpl, { show: true, v: "a" })).toBe("A");
			expect(await engine.render_string(tmpl, { show: false, v: "a" })).toBe("");
		});

		test("throws for unclosed switch", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#switch props.x}hello")).rejects.toThrow("Unclosed block(s): switch");
		});

		test("throws for unmatched /switch", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{/switch}")).rejects.toThrow("Unexpected {/switch}");
		});

		test("throws for a case outside a switch", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#case 1}x{/switch}")).rejects.toThrow("Unexpected {#case}");
		});

		test("throws for empty switch expression", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#switch }x{/switch}")).rejects.toThrow("Invalid #switch syntax");
		});

		test("throws for empty case value", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#switch props.x}{#case }x{/switch}")).rejects.toThrow("Invalid #case syntax");
		});

		test("throws for a case after the default else", async () => {
			const engine = make_engine("/tmp");
			await expect(engine.render_string("{#switch props.x}{#case 1}a{:else}b{#case 2}c{/switch}")).rejects.toThrow("{#case} after {:else}");
		});

		test("a default else with no cases always renders - matches JS switch semantics", async () => {
			const engine = make_engine("/tmp");
			expect(await engine.render_string("{#switch props.x}{:else}default{/switch}", { x: 1 })).toBe("default");
		});
	});

	describe("#each / {:else} / {/each}", () => {
		test("iterates over array", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#each props.items as item}{= item }{/each}";
			expect(await engine.render_string(tmpl, { items: ["a", "b", "c"] })).toBe("abc");
		});

		test("provides index variable", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#each props.items as item, idx}{= idx }:{= item },{/each}";
			expect(await engine.render_string(tmpl, { items: ["x", "y"] })).toBe("0:x,1:y,");
		});

		test("provides key variable for objects", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#each props.items as val, idx, key}{= key }={= val },{/each}";
			const result = await engine.render_string(tmpl, { items: { a: 1, b: 2 } });
			expect(result).toBe("a=1,b=2,");
		});

		test("renders else when empty", async () => {
			const engine = make_engine("/tmp");
			const tmpl = "{#each props.items as item}{= item }{:else}empty{/each}";
			expect(await engine.render_string(tmpl, { items: [] })).toBe("empty");
		});
	});

	describe("file-based render", () => {
		test("loads and renders a template file", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "hello.ree"), "Hello {= props.name }!");
			const result = await engine.render("hello", { name: "reepolee" });
			expect(result).toBe("Hello reepolee!");
		}));

		test("throws for missing template", with_temp_dir(async (dir, engine) => await expect(engine.render("nonexistent")).rejects.toThrow("not found")));

		test("renders templates and layouts from a mounted route module", with_temp_dir(async (dir) => {
			const module_root = join(dirname(dir), "marketplace", "studio");
			mkdirSync(module_root, { recursive: true });
			writeFileSync(join(module_root, "index.ree"), "{#layout(\"studio/layout\")}<h1>{= props.title }</h1>");
			writeFileSync(join(module_root, "layout.ree"), "<main>{~ props.body }</main>");
			const route_module_mounts = [{ module_code: "studio", module_root }];
			const engine = make_engine(dir, route_module_mounts);

			const result = await engine.render("studio/index", { title: "Studio" });

			expect(without_stamps(result)).toBe("<main><h1>Studio</h1></main>");
		}));

		test("rejects traversal outside a mounted route module", with_temp_dir(async (dir) => {
			const module_root = join(dirname(dir), "marketplace", "studio");
			mkdirSync(module_root, { recursive: true });
			const route_module_mounts = [{ module_code: "studio", module_root }];
			const engine = make_engine(dir, route_module_mounts);
			const render_result = engine.render("studio/../secret");

			await expect(render_result).rejects.toThrow("escapes mounted route module");
		}));
	});

	describe("includes", () => {
		test(
			"{#include} renders partial template (Props passed via props.* reference)",
			with_temp_dir(async (dir, engine) => {
				writeFileSync(join(dir, "_header.ree"), "<header>{= props.title }</header>");
				// Use props.incData so the expression resolves via the props object
				const tmpl = "<main>{#include(\"_header\", props.incData )}</main>";
				writeFileSync(join(dir, "page.ree"), tmpl);
				const result = await engine.render("page", { incData: { title: "Hi" } });
				expect(without_stamps(result)).toBe("<main><header>Hi</header></main>");
			})
		);

		test("nested includes work (include within include)", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "_shared.ree"), "<small>{= props.text }</small>");
			writeFileSync(join(dir, "_section.ree"), "<section>{#include(\"_shared\", props.inner )}</section>");
			writeFileSync(join(dir, "page.ree"), "<div>{#include(\"_section\", props.sec )}</div>");
			const result = await engine.render("page", { sec: { inner: { text: "nested" } } });
			expect(without_stamps(result)).toBe("<div><section><small>nested</small></section></div>");
		}));

		test(
			"relative include path ./ works",
			with_temp_dir(async (dir, engine) => {
				mkdirSync(join(dir, "partials"), { recursive: true });
				writeFileSync(join(dir, "partials", "_footer.ree"), "<footer>{= props.text }</footer>");
				// The include path is relative to the template's directory
				writeFileSync(join(dir, "page.ree"), "<main>{#include(\"./partials/_footer\", props.footerData )}</main>");
				const result = await engine.render("page", { footerData: { text: "Footer" } });
				expect(without_stamps(result)).toBe("<main><footer>Footer</footer></main>");
			})
		);
		test(
			"localized include fallback works",
			with_temp_dir(async (dir, engine) => {
				// Create language-specific templates and a default
				writeFileSync(join(dir, `_header.${TEST_DEFAULT_LOCALE}.ree`), "<header>Hello</header>");
				writeFileSync(join(dir, "_header.ree"), "<header>Default</header>");
				// Use props.emptyData to reference empty data instead of {} which confuses the parser
				writeFileSync(join(dir, "page.ree"), "{#include(\"_header\", props.emptyData )}");

				const default_variant = await engine.render("page", { locale: TEST_DEFAULT_LOCALE, emptyData: {} });
				expect(without_stamps(default_variant)).toBe("<header>Hello</header>");

				const missing_language = (TEST_DEFAULT_LOCALE as string) === "alternate" ? "fallback" : "alternate";
				const fallback = await engine.render("page", { locale: missing_language, emptyData: {} });
				expect(without_stamps(fallback)).toBe("<header>Hello</header>");
			})
		);
	});

	describe("layouts", () => test("{#layout} wraps content - body must use {~ ... } (unescaped) since it contains HTML", with_temp_dir(async (dir, engine) => {
		writeFileSync(join(dir, "_layout.ree"), "<html><body>{~ props.body }</body></html>");
		writeFileSync(join(dir, "child.ree"), "{#layout(\"_layout\")}<h1>Content</h1>");
		const result = await engine.render("child");
		expect(without_stamps(result)).toBe("<html><body><h1>Content</h1></body></html>");
	})));

	describe("components", () => {
		test("ReeTag <tag-name> includes from components/ dir", with_temp_dir(async (dir, engine) => {
			const components_dir = join(dirname(dir), "components");
			mkdirSync(components_dir, { recursive: true });
			writeFileSync(join(components_dir, "my-badge.ree"), "<span class='badge'>{= props.attributes.label }</span>");
			writeFileSync(join(dir, "page.ree"), "<div><my-badge label='New'></my-badge></div>");
			const result = await engine.render("page");
			expect(without_stamps(result)).toBe("<div><span class='badge'>New</span></div>");
			rmSync(components_dir, { recursive: true, force: true });
		}));

		test("{#include} explicitly resolves a component from components/ dir", with_temp_dir(async (dir, engine) => {
			const components_dir = join(dirname(dir), "components");
			mkdirSync(components_dir, { recursive: true });
			writeFileSync(join(components_dir, "my-badge.ree"), "<span class='badge'>{= props.label }</span>");
			writeFileSync(join(dir, "page.ree"), "{#include(\"$components/my-badge\")}");
			const result = await engine.render("page", { label: "New" });
			expect(result).toBe("<span class='badge'>New</span>");
			rmSync(components_dir, { recursive: true, force: true });
		}));

		test("{_ path} inside a ReeTag attribute resolves against props.translations", with_temp_dir(async (dir, engine) => {
			const components_dir = join(dirname(dir), "components");
			mkdirSync(components_dir, { recursive: true });
			writeFileSync(join(components_dir, "my-badge.ree"), "<span class='badge'>{= props.attributes.label }</span>");
			writeFileSync(join(dir, "page.ree"), "<my-badge label=\"{_ ui.title }\"></my-badge>");
			const result = await engine.render("page", { translations: { ui: { title: "Kitchen Sink" } } });
			expect(result).toBe("<span class='badge'>Kitchen Sink</span>");
			rmSync(components_dir, { recursive: true, force: true });
		}));

		test("{_ path} inside a ReeTag attribute renders {last_segment} on a miss", with_temp_dir(async (dir, engine) => {
			const components_dir = join(dirname(dir), "components");
			mkdirSync(components_dir, { recursive: true });
			writeFileSync(join(components_dir, "my-badge.ree"), "<span class='badge'>{= props.attributes.label }</span>");
			writeFileSync(join(dir, "page.ree"), "<my-badge label=\"{_ ui.title }\"></my-badge>");
			const result = await engine.render("page", { translations: {} });
			expect(result).toBe("<span class='badge'>{title}</span>");
			rmSync(components_dir, { recursive: true, force: true });
		}));

		test("{- path} inside a ReeTag attribute resolves against props.translations", with_temp_dir(async (dir, engine) => {
			const components_dir = join(dirname(dir), "components");
			mkdirSync(components_dir, { recursive: true });
			writeFileSync(join(components_dir, "my-badge.ree"), "<span class='badge'>{= props.attributes.label }</span>");
			writeFileSync(join(dir, "page.ree"), "<my-badge label=\"{- ui.title }\"></my-badge>");
			const result = await engine.render("page", { translations: { ui: { title: "Kitchen Sink" } } });
			expect(result).toBe("<span class='badge'>Kitchen Sink</span>");
			rmSync(components_dir, { recursive: true, force: true });
		}));
	});

	describe("custom HTML elements", () => {
		test("unknown custom element <tag-name> is passed through as literal HTML", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<toasts-area>content</toasts-area>");
			expect(result).toBe("<toasts-area>content</toasts-area>");
		}));

		test("unknown custom element preserves HTML attributes", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<toasts-area class=\"foo\" id=\"bar\">content</toasts-area>");
			expect(result).toBe("<toasts-area class=\"foo\" id=\"bar\">content</toasts-area>");
		}));

		test("interpolated attribute on a passthrough element is evaluated (regression test)", with_temp_dir(async (_dir, engine) => {
			// Passthrough tags are emitted from inside a {{ ... }} block, which the main
			// pass never rescans - the attributes used to render as literal text, so
			// every component's <validation-error id="error-{= ... }"> was a dead id.
			const result = await engine.render_string("<validation-error id=\"error-{= props.name }\"></validation-error>", { name: "email" });
			expect(result).toBe("<validation-error id=\"error-email\"></validation-error>");
		}));

		test("passthrough element mixes literal and interpolated attributes", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<field-wrapper class=\"grid\" data-x=\"{= props.n }\" hidden></field-wrapper>", { n: "7" });
			expect(result).toBe("<field-wrapper class=\"grid\" data-x=\"7\" hidden></field-wrapper>");
		}));

		test("interpolated attribute on a passthrough element is HTML-escaped", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<my-tag title=\"{= props.v }\"></my-tag>", { v: "a\"b<c" });
			expect(result).toBe("<my-tag title=\"a&quot;b&lt;c\"></my-tag>");
		}));

		test("{~ } on a passthrough element attribute is not escaped", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<my-tag data-raw=\"{~ props.v }\"></my-tag>", { v: "a&b" });
			expect(result).toBe("<my-tag data-raw=\"a&b\"></my-tag>");
		}));

		test("{_ path} on a passthrough element attribute resolves a translation", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<my-tag title=\"{_ ui.save }\"></my-tag>", { translations: { ui: { save: "Shrani" } } });
			expect(result).toBe("<my-tag title=\"Shrani\"></my-tag>");
		}));

		test("unbalanced brace in a passthrough attribute stays literal", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<my-tag title=\"{= props.v \"></my-tag>", { v: "x" });
			expect(result).toBe("<my-tag title=\"{= props.v \"></my-tag>");
		}));

		test("deeply nested unknown custom elements do not OOM (regression test)", async () => {
			const engine = make_engine("/tmp");
			const nesting = 20;
			// Build deeply nested structure with hyphenated tags so cust_elem_regex matches them:
			// <x-one><x-two>...<x-twenty>text</x-twenty>...</x-two></x-one>
			let tmpl = "text";
			for (let i = 0; i < nesting; i++) {
				// e.g. x-one, x-two, x-three, ...
				const suffixes = [
					"one",
					"two",
					"three",
					"four",
					"five",
					"six",
					"seven",
					"eight",
					"nine",
					"ten",
					"eleven",
					"twelve",
					"thirteen",
					"fourteen",
					"fifteen",
					"sixteen",
					"seventeen",
					"eighteen",
					"nineteen",
					"twenty",
				];
				const tag = `x-${suffixes[i]}`;
				tmpl = `<${tag}>${tmpl}</${tag}>`;
			}
			const start = performance.now();
			const result = await engine.render_string(tmpl);
			const elapsed = performance.now() - start;
			// Should complete quickly (< 2s) - if it takes longer, it likely infinite-looped
			expect(elapsed).toBeLessThan(2000);
			// Verify the full nesting was preserved
			expect(result).toBe(tmpl);
		});

		test("template directives inside unknown custom element slots still work", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<wrapper>{= props.message }</wrapper>", { message: "Hello from inside!" });
			expect(result).toBe("<wrapper>Hello from inside!</wrapper>");
		}));
		test(
			"known component file takes priority over unknown element passthrough",
			with_temp_dir(async (dir, engine) => {
				// Create a matching component file
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				// HTML attributes on the tag are passed as props.attributes.*
				writeFileSync(join(components_dir, "my-badge.ree"), "<span class='badge'>{= props.attributes.label }</span>");
				writeFileSync(join(dir, "page.ree"), "<my-badge label='New'>slot</my-badge>");
				const result = await engine.render("page");
				expect(result).toBe("<span class='badge'>New</span>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"<auto-complete> renders component with HTML attributes passed as props.attributes",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				// Component echoes its attributes as data-* attrs on a wrapper div
				writeFileSync(
					join(components_dir, "auto-complete.ree"),
					"<div class=\"ac\" data-field=\"{= props.attributes[\"field-name\"] }\" data-fk-table=\"{= props.attributes[\"fk-table\"] }\" data-fk-column=\"{= props.attributes[\"fk-column\"] }\" data-base-url=\"{= props.attributes[\"base-url\"] }\" data-rows=\"{= props.attributes[\"rows\"] }\"></div>"
				);
				writeFileSync(
					join(dir, "page.ree"),
					"<auto-complete field-name=\"legal_entity_registration_number\" fk-table=\"legal_entities\" fk-column=\"registration_number\" base-url=\"/partners\" rows=\"15\"></auto-complete>"
				);
				const result = await engine.render("page");
				expect(result).toContain("data-field=\"legal_entity_registration_number\"");
				expect(result).toContain("data-fk-table=\"legal_entities\"");
				expect(result).toContain("data-fk-column=\"registration_number\"");
				expect(result).toContain("data-base-url=\"/partners\"");
				expect(result).toContain("data-rows=\"15\"");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"<auto-complete> receives parent props (fields, record) via Object.assign",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				// Component accesses props.fields and props.record from parent scope
				writeFileSync(
					join(components_dir, "auto-complete.ree"),
					"<div class=\"ac\" data-field=\"{= props.attributes[\"field-name\"] }\">" + "<span class=\"field-label\">{= props.fields?.[props.attributes[\"field-name\"]]?.label }</span>" + "<span class=\"field-value\">{= props.record?.[props.attributes[\"field-name\"]] }</span>" + "</div>"
				);
				writeFileSync(join(dir, "page.ree"), "<auto-complete field-name=\"company_id\"></auto-complete>");

				const fields = { company_id: { label: "Company", type: "autocomplete" } };
				const record = { company_id: 42 };
				const result = await engine.render("page", { fields, record });

				expect(result).toContain("data-field=\"company_id\"");
				expect(result).toContain("<span class=\"field-label\">Company</span>");
				expect(result).toContain("<span class=\"field-value\">42</span>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"multiple <auto-complete> elements on page each render independently",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				// Component renders a wrapper with field-name as data-field
				writeFileSync(join(components_dir, "auto-complete.ree"), "<div class=\"ac\" data-field=\"{= props.attributes[\"field-name\"] }\"></div>");
				writeFileSync(
					join(dir, "page.ree"),
					"<auto-complete field-name=\"company_id\"></auto-complete>" + "<br>" + "<auto-complete field-name=\"partner_id\" rows=\"10\"></auto-complete>"
				);
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"ac\" data-field=\"company_id\"></div>" + "<br>" + "<div class=\"ac\" data-field=\"partner_id\"></div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"<auto-complete> slot content is rendered as children prop",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				// Component renders children slot content wrapped in a div
				writeFileSync(join(components_dir, "auto-complete.ree"), "<div class=\"ac-wrapper\">{~ props.children }</div>");
				writeFileSync(join(dir, "page.ree"), "<auto-complete><span class=\"hint\">Type to search</span></auto-complete>");
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"ac-wrapper\"><span class=\"hint\">Type to search</span></div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"spread ...identifier on a plain (non-hyphenated) element renders attributes",
			with_temp_dir(async (_dir, engine) => {
				// Only hyphenated tags used to expand spreads, so a component rendering
				// a plain <div> (the shipped app-banner) emitted a literal "...rest".
				const key_values = (rest: any) => Object.entries(rest).map(([k, v]) => v === true ? k : v === false || v == null ? "" : `${k}="${String(v)}"`).filter(Boolean).join(" ");
				const tmpl = "{{ const attrs = { id: \"bar\", \"data-k\": \"v\" }; }}<div class=\"foo\" ...attrs>content</div>";
				const result = await engine.render_string(tmpl, { helpers: { key_values } });
				expect(result).toBe(`<div class="foo" id="bar" data-k="v">content</div>`);
			})
		);

		test(
			"rest-destructuring in a {{ }} block is not mistaken for an attribute spread",
			with_temp_dir(async (_dir, engine) => {
				// The app-banner shape: ...rest appears twice, once as JS and once as markup.
				const key_values = (rest: any) => Object.entries(rest).map(([k, v]) => v === true ? k : v === false || v == null ? "" : `${k}="${String(v)}"`).filter(Boolean).join(" ");
				const tmpl = "{{ const { type = \"green\", ...rest } = { type: \"red\", id: \"q\" }; }}<div class=\"{= type }\" ...rest>x</div>";
				const result = await engine.render_string(tmpl, { helpers: { key_values } });
				expect(result).toBe(`<div class="red" id="q">x</div>`);
			})
		);

		test(
			"spread ...a.b.c (dotted path) renders attributes from a nested object",
			with_temp_dir(async (_dir, engine) => {
				const key_values = (rest: any) => Object.entries(rest).map(([k, v]) => v === true ? k : v === false || v == null ? "" : `${k}="${String(v)}"`).filter(Boolean).join(" ");
				const tmpl = "{{ const widget = { profile: { id: \"u1\", \"data-role\": \"admin\" } }; }}<div class=\"c\" ...widget.profile>x</div>";
				const result = await engine.render_string(tmpl, { helpers: { key_values } });
				expect(result).toBe(`<div class="c" id="u1" data-role="admin">x</div>`);
			})
		);

		test(
			"spread ...a.b.c (dotted path) works on a ReeTag",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				writeFileSync(join(components_dir, "my-chip.ree"), "<b>{= props.attributes.id }</b>");
				writeFileSync(join(dir, "page.ree"), "{{ const widget = { profile: { id: \"u1\" } }; }}<my-chip ...widget.profile></my-chip>");
				const result = await engine.render("page");
				expect(without_stamps(result)).toBe("<b>u1</b>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"JS spread inside a <script> body is left alone",
			with_temp_dir(async (_dir, engine) => {
				const tmpl = "<script>const b = [...a, 3];</script>";
				const result = await engine.render_string(tmpl, {});
				expect(result).toBe("<script>const b = [...a, 3];</script>");
			})
		);

		test(
			"JS spread inside an interpolated attribute value is left alone",
			with_temp_dir(async (_dir, engine) => {
				const tmpl = "{{ const nums = [3, 1]; }}<div data-max=\"{= Math.max(...nums) }\"></div>";
				const result = await engine.render_string(tmpl, {});
				expect(result).toBe(`<div data-max="3"></div>`);
			})
		);

		test(
			"spread ...identifier on native element passthrough renders attributes",
			with_temp_dir(async (_dir, engine) => {
				// key_values must be provided via helpers (it's a default helper in production)
				const key_values = (rest: any) => Object.entries(rest).map(([k, v]) => v === true ? k : v === false || v == null ? "" : `${k}="${String(v)}"`).filter(Boolean).join(
					" "
				);
				const tmpl = "{{ const attrs = { class: \"foo\", id: \"bar\" }; }}<my-element ...attrs>content</my-element>";
				const result = await engine.render_string(tmpl, { helpers: { key_values } });
				expect(result).toBe(`<my-element class="foo" id="bar">content</my-element>`);
			})
		);

		test(
			"spread on native element with explicit attributes",
			with_temp_dir(async (_dir, engine) => {
				const key_values = (rest: any) => Object.entries(rest).map(([k, v]) => v === true ? k : v === false || v == null ? "" : `${k}="${String(v)}"`).filter(Boolean).join(
					" "
				);
				// Spread + explicit attr: spreads come first, explicit attrs follow
				const tmpl = "{{ const attrs = { class: \"from-spread\" }; }}<my-element ...attrs class=\"explicit\">content</my-element>";
				const result = await engine.render_string(tmpl, { helpers: { key_values } });
				expect(result).toContain("class=\"from-spread\"");
				expect(result).toContain("class=\"explicit\"");
			})
		);

		test(
			"spread ...identifier on ReeTag spreads local object as attributes",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				// Component renders each property of props.attributes as data-* attr
				writeFileSync(
					join(components_dir, "my-card.ree"),
					"<div class=\"card\" data-title=\"{= props.attributes.title }\" data-count=\"{= props.attributes.count }\">{~ props.children }</div>"
				);
				// Template defines a local object and spreads it onto the component
				const tmpl = "{{ const attrs = { title: \"Hello\", count: 42 }; }}<my-card ...attrs>content</my-card>";
				writeFileSync(join(dir, "page.ree"), tmpl);
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"card\" data-title=\"Hello\" data-count=\"42\">content</div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"explicit attributes override spread properties on ReeTag",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				// Component outputs the class attribute
				writeFileSync(join(components_dir, "my-card.ree"), "<div class=\"card\" data-class=\"{= props.attributes.class }\">{~ props.children }</div>");
				// Template has spread object with class=\"a\" and explicit class=\"b\" - explicit should win
				const tmpl = "{{ const attrs = { class: \"from-spread\" }; }}<my-card ...attrs class=\"explicit\">content</my-card>";
				writeFileSync(join(dir, "page.ree"), tmpl);
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"card\" data-class=\"explicit\">content</div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"multiple spreads on the same ReeTag",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				writeFileSync(
					join(components_dir, "my-card.ree"),
					"<div class=\"card\" data-title=\"{= props.attributes.title }\" data-count=\"{= props.attributes.count }\" data-mode=\"{= props.attributes.mode }\">{~ props.children }</div>"
				);
				// Two spreads: second overrides first for duplicate keys
				const tmpl = "{{ const a = { title: \"A\", count: 1 }; }}{{ const b = { count: 2, mode: \"dark\" }; }}<my-card ...a ...b>content</my-card>";
				writeFileSync(join(dir, "page.ree"), tmpl);
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"card\" data-title=\"A\" data-count=\"2\" data-mode=\"dark\">content</div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"spread with interpolated expression attribute on ReeTag",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				writeFileSync(
					join(components_dir, "my-card.ree"),
					"<div class=\"card\" data-title=\"{= props.attributes.title }\" data-mode=\"{= props.attributes.mode }\">{~ props.children }</div>"
				);
				// Spread with interpolated {~ expr } attr should both work
				const tmpl = "{{ const attrs = { title: \"FromSpread\" }; }}{{ const mode = \"dynamic\"; }}<my-card ...attrs mode=\"{~ mode}\">content</my-card>";
				writeFileSync(join(dir, "page.ree"), tmpl);
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"card\" data-title=\"FromSpread\" data-mode=\"dynamic\">content</div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"spread with boolean attribute on ReeTag",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				writeFileSync(
					join(components_dir, "my-card.ree"),
					"<div class=\"card\" data-title=\"{= props.attributes.title }\" data-disabled=\"{= props.attributes.disabled }\">{~ props.children }</div>"
				);
				// Spread object + boolean attribute
				const tmpl = "{{ const attrs = { title: \"Hello\" }; }}<my-card ...attrs disabled>content</my-card>";
				writeFileSync(join(dir, "page.ree"), tmpl);
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"card\" data-title=\"Hello\" data-disabled=\"true\">content</div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);

		test(
			"spread within an each loop on ReeTag",
			with_temp_dir(async (dir, engine) => {
				const components_dir = join(dirname(dir), "components");
				mkdirSync(components_dir, { recursive: true });
				writeFileSync(
					join(components_dir, "my-card.ree"),
					"<div class=\"card\" data-label=\"{= props.attributes.label }\" data-id=\"{= props.attributes.id }\">{~ props.children }</div>"
				);
				// Spread inside an #each loop - each item's attrs spread onto the component.
				// Slot content can't reference loop variables (slot is a standalone CompiledFn),
				// so we use static text and verify the spread attributes from outer context.
				const tmpl = "{{ const items = [{ id: 1, label: \"One\" }, { id: 2, label: \"Two\" }]; }}{#each items as item}<my-card ...item>item</my-card>{/each}";
				writeFileSync(join(dir, "page.ree"), tmpl);
				const result = await engine.render("page");
				expect(result).toBe("<div class=\"card\" data-label=\"One\" data-id=\"1\">item</div><div class=\"card\" data-label=\"Two\" data-id=\"2\">item</div>");
				rmSync(components_dir, { recursive: true, force: true });
			})
		);
	});

	describe("HTML comments", () => {
		test("expressions inside HTML comments are NOT evaluated", async () => {
			const engine = make_engine("/tmp");
			// {= props.x } inside <!-- --> should be stripped before compilation
			const result = await engine.render_string("before<!-- {= props.x } -->after", { x: "CRASH" });
			expect(result).toBe("beforeafter");
		});

		test("expressions outside HTML comments are still evaluated", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("{= props.greeting }<!-- comment -->{= props.name }", {
				greeting: "Hello",
				name: "World",
			});
			expect(result).toBe("HelloWorld");
		});

		test("HTML comments with multi-line content are stripped", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("<!--\n\t<div class=\"{= props.cls }\">{= props.val }</div>\n-->shown", {
				cls: "foo",
				val: "bar",
			});
			// The expression inside the comment should NOT be evaluated
			expect(result).toBe("shown");
		});

		test("directives inside HTML comments are not processed", async () => {
			const engine = make_engine("/tmp");
			const result = await engine.render_string("start<!-- {#if true}SHOULD_NOT_APPEAR{/if} -->end");
			expect(result).toBe("startend");
		});
	});

	describe("HTML escaping", () => {
		test("escape() handles null/undefined", () => {
			const engine = make_engine("/tmp");
			expect(engine.escape(null)).toBe("");
			expect(engine.escape(undefined)).toBe("");
		});

		test("escape() converts special characters", () => {
			const engine = make_engine("/tmp");
			expect(engine.escape("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
		});

		test("escape() converts numbers", () => {
			const engine = make_engine("/tmp");
			expect(engine.escape(42)).toBe("42");
		});
	});

	describe("language-aware loading", () => {
		test("load_localized falls back through locale chain", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "page.sl-si.ree"), "Pozdravljeni!");
			writeFileSync(join(dir, "page.en-us.ree"), "Hello!");
			const sl = await engine.load_localized("page", "sl-si");
			expect(sl.content).toContain("Pozdravljeni");
			const en = await engine.load_localized("page", "en-us");
			expect(en.content).toContain("Hello");
		}));

		test("a bare language subtag is not a locale variant", with_temp_dir(async (dir, engine) => {
			// "sl" is not a configured locale - only full language-region codes
			// count, so page.sl.ree is a plain file, not a variant of page.
			writeFileSync(join(dir, "page.sl.ree"), "Not a variant");
			writeFileSync(join(dir, "page.ree"), "Base");
			const result = await engine.load_localized("page", "sl");
			expect(result.content).toContain("Base");
		}));

		test("load_localized falls back to the default locale then bare file", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "page.ree"), "Default fallback");
			const result = await engine.load_localized("page", "de");
			expect(result.content).toContain("Default fallback");
		}));

		test("render uses locale-specific template when available", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "greet.en-us.ree"), "Hello");
			writeFileSync(join(dir, "greet.sl-si.ree"), "Zdravo");
			writeFileSync(join(dir, "greet.ree"), "Hi");
			const en = await engine.render("greet", { locale: "en-us" });
			expect(en).toBe("Hello");
			const sl = await engine.render("greet", { locale: "sl-si" });
			expect(sl).toBe("Zdravo");
		}));
	});

	describe("helpers - static injection", () => {
		test("built-in helper names are bound as bare identifiers", async () => {
			const engine = make_engine("/tmp");
			const helpers = { url: (p: string) => (p.startsWith("/") ? p : `/${p}`) };
			const result = await engine.render_string("{= url('x') }", { helpers });
			expect(result).toBe("/x");
		});

		test("custom helpers are reachable via helpers.<name>, not as bare names", async () => {
			const engine = make_engine("/tmp");
			// Only DEFAULT_HELPER_NAMES get bare-identifier bindings; custom
			// helpers go through the helpers object (the eval loop that used to
			// inject arbitrary names deoptimized every render).
			const helpers = { custom_upper: (s: string) => s.toUpperCase() };
			const via_object = await engine.render_string("{= helpers.custom_upper('hello') }", { helpers });
			expect(via_object).toBe("HELLO");

			await expect(engine.render_string("{= custom_upper('hello') }", { helpers })).rejects.toThrow();
		});

		test("non-function helper values do not break rendering", async () => {
			const engine = make_engine("/tmp");
			const helpers = { custom_data: { foo: "bar" } };
			const result = await engine.render_string("Hello", { helpers });
			expect(result).toBe("Hello");
		});
	});

	describe("cache", () => {
		test("caches compiled file templates when enabled", with_temp_dir(async (dir, _engine) => {
			const cached_engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "t.ree"), "a");
			await cached_engine.render("t");
			expect(Object.keys(cached_engine.compiled_cache).length).toBe(1);
		}));

		test("clear_cache empties compiled cache", async () => {
			const engine = new TE({ views: "/tmp", cache: true, ext: ".ree" });
			await engine.render_string("x");
			engine.clear_cache();
			expect(Object.keys(engine.compiled_cache).length).toBe(0);
		});
	});

	describe("precompile", () => {
		test("precompile caches templates by name and file path (prod)", with_temp_dir(async (dir) => {
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "t.ree"), "Hello {= props.name }!");
			await precompile_templates(engine);
			expect(engine.compiled_cache["t"]).toBeDefined();
			expect(Object.keys(engine.compiled_cache).length).toBe(2); // name + absolute path
			expect(await engine.render("t", { name: "reepolee" })).toBe("Hello reepolee!");
		}));

		test("precompiled templates are not re-read from disk in prod", with_temp_dir(async (dir) => {
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "t.ree"), "v1");
			await precompile_templates(engine);
			expect(await engine.render("t")).toBe("v1");
			writeFileSync(join(dir, "t.ree"), "v2");
			expect(await engine.render("t")).toBe("v1"); // precompiled fn wins
		}));

		test("without precompile, prod lazy path is also compile-once (stale after edit)", with_temp_dir(async (dir) => {
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "t.ree"), "v1");
			expect(await engine.render("t")).toBe("v1");
			writeFileSync(join(dir, "t.ree"), "v2");
			// The lazy path read the file but served the cached compiled fn -
			// prod has always been compile-once; precompile just removes the read.
			expect(await engine.render("t")).toBe("v1");
		}));

		test("precompile registers locale variants for zero-I/O resolution", with_temp_dir(async (dir) => {
			// Locales pinned explicitly, not read from config: the assertion below
			// turns on "en-us" having no variant file, so it must not depend on
			// which locale the app (or another test file's module mock) makes
			// default.
			const engine = new TE({ views: dir, cache: true, ext: ".ree", locales: ["en-us", "sl-si"], default_locale: "en-us" });
			writeFileSync(join(dir, "page.ree"), "Base");
			writeFileSync(join(dir, "page.sl-si.ree"), "Pozdrav");
			await precompile_templates(engine);
			expect(await engine.render("page", { locale: "sl-si" })).toBe("Pozdrav");
			expect(await engine.render("page", { locale: "en-us" })).toBe("Base");
			expect(await engine.render("page")).toBe("Base");
		}));

		test("precompiled alias include ($components/) is served from cache", async () => {
			// $components/ sits under the project root, outside the views tree.
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			const components_dir = join(project_root, "components");
			mkdirSync(dir, { recursive: true });
			mkdirSync(components_dir, { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "page.ree"), "<main>{#include(\"$components/partial\")}</main>");
				writeFileSync(join(components_dir, "partial.ree"), "<p>v1</p>");
				await precompile_templates(engine);
				expect(await engine.render("page")).toBe("<main><p>v1</p></main>");
				writeFileSync(join(components_dir, "partial.ree"), "<p>v2</p>");
				expect(await engine.render("page")).toBe("<main><p>v1</p></main>"); // cached, no re-read
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("precompile registers components for ReeTag resolution", with_temp_dir(async (dir) => {
			const components_dir = join(dirname(dir), "components");
			mkdirSync(components_dir, { recursive: true });
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(components_dir, "my-badge.ree"), "<span>{= props.attributes.label }</span>");
			writeFileSync(join(dir, "page.ree"), "<my-badge label=\"X\"></my-badge>");
			await precompile_templates(engine);
			expect(engine.component_paths.get("my-badge")).toBe("$components/my-badge");
			expect(await engine.render("page")).toBe("<span>X</span>");
			rmSync(components_dir, { recursive: true, force: true });
		}));

		test("precompile resolves ReeTags from routes subfolders (prod)", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			mkdirSync(join(dir, "examples", "kitchen_sink"), { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "examples", "kitchen_sink", "star-rating.ree"), "<div class='stars'>{= props.attributes.label }</div>");
				writeFileSync(join(dir, "examples", "kitchen_sink", "page.ree"), "<main><star-rating label='Rating'></star-rating></main>");
				await precompile_templates(engine);
				expect(engine.component_paths.get("star-rating")).toBe("examples/kitchen_sink/star-rating");
				expect(await engine.render("examples/kitchen_sink/page")).toBe("<main><div class='stars'>Rating</div></main>");
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("components/ wins over a same-named routes-tree file", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			const components_dir = join(project_root, "components");
			mkdirSync(join(dir, "sub"), { recursive: true });
			mkdirSync(components_dir, { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "sub", "my-badge.ree"), "<b>tree</b>");
				writeFileSync(join(components_dir, "my-badge.ree"), "<i>shared</i>");
				writeFileSync(join(dir, "page.ree"), "<my-badge></my-badge>");
				await precompile_templates(engine);
				expect(engine.component_paths.get("my-badge")).toBe("$components/my-badge");
				expect(await engine.render("page")).toBe("<i>shared</i>");
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("precompile throws on two same-named components in one root", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			mkdirSync(join(dir, "a"), { recursive: true });
			mkdirSync(join(dir, "b"), { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "a", "my-badge.ree"), "<b>a</b>");
				writeFileSync(join(dir, "b", "my-badge.ree"), "<i>b</i>");
				await expect(precompile_templates(engine)).rejects.toThrow(/ambiguous component tag\(s\)[\s\S]*my-badge/);
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("repeated non-ReeTag page names (form.ree, index.ree) are not ambiguous", async () => {
			// Only hyphenated names are matched as custom elements, so ordinary
			// route pages repeated across folders must never trip the guard.
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			mkdirSync(join(dir, "login"), { recursive: true });
			mkdirSync(join(dir, "register"), { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "login", "form.ree"), "<p>login</p>");
				writeFileSync(join(dir, "register", "form.ree"), "<p>register</p>");
				const result = await precompile_templates(engine);
				expect(result.total).toBe(2);
				expect(await engine.render("login/form")).toBe("<p>login</p>");
				expect(await engine.render("register/form")).toBe("<p>register</p>");
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("a components/ file resolves an otherwise ambiguous tag", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			const components_dir = join(project_root, "components");
			mkdirSync(join(dir, "a"), { recursive: true });
			mkdirSync(join(dir, "b"), { recursive: true });
			mkdirSync(components_dir, { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "a", "my-badge.ree"), "<b>a</b>");
				writeFileSync(join(dir, "b", "my-badge.ree"), "<i>b</i>");
				writeFileSync(join(components_dir, "my-badge.ree"), "<em>shared</em>");
				writeFileSync(join(dir, "page.ree"), "<my-badge></my-badge>");
				await precompile_templates(engine);
				expect(engine.component_paths.get("my-badge")).toBe("$components/my-badge");
				expect(await engine.render("page")).toBe("<em>shared</em>");
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("locale variants of one component are not ambiguous", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			mkdirSync(join(dir, "widgets"), { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "widgets", "hello-card.ree"), "<div>Base</div>");
				writeFileSync(join(dir, "widgets", "hello-card.sl.ree"), "<div>Pozdrav</div>");
				writeFileSync(join(dir, "widgets", "page.ree"), "<hello-card></hello-card>");
				await precompile_templates(engine);
				expect(engine.component_paths.get("hello-card")).toBe("widgets/hello-card");
				expect(await engine.render("widgets/page")).toBe("<div>Base</div>");
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("dev self-heal throws on two same-named components in the views tree", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			mkdirSync(join(dir, "a"), { recursive: true });
			mkdirSync(join(dir, "b"), { recursive: true });
			try {
				const engine = make_engine(dir); // cache: false, no precompile
				writeFileSync(join(dir, "a", "my-badge.ree"), "<b>a</b>");
				writeFileSync(join(dir, "b", "my-badge.ree"), "<i>b</i>");
				writeFileSync(join(dir, "page.ree"), "<my-badge></my-badge>");
				await expect(engine.render("page")).rejects.toThrow(/Ambiguous component[\s\S]*my-badge/);
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("a views-tree component still shadows a same-named module file", with_temp_dir(async (dir) => {
			const module_root = join(dirname(dir), "marketplace", "studio");
			mkdirSync(module_root, { recursive: true });
			mkdirSync(join(dir, "sub"), { recursive: true });
			writeFileSync(join(dir, "sub", "my-chip.ree"), "<b>tree</b>");
			writeFileSync(join(module_root, "my-chip.ree"), "<i>module</i>");
			writeFileSync(join(dir, "page.ree"), "<my-chip></my-chip>");
			const engine = new TE({ views: dir, cache: true, ext: ".ree", route_module_mounts: [{ module_code: "studio", module_root }] });
			await precompile_templates(engine);
			expect(engine.component_paths.get("my-chip")).toBe("sub/my-chip");
			expect(await engine.render("page")).toBe("<b>tree</b>");
		}));

		test("routes-subfolder ReeTag resolves lazily in dev (self-heal)", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			mkdirSync(join(dir, "examples", "kitchen_sink"), { recursive: true });
			try {
				const engine = make_engine(dir); // cache: false
				writeFileSync(join(dir, "examples", "kitchen_sink", "star-rating.ree"), "<div class='stars'>{= props.attributes.label }</div>");
				writeFileSync(join(dir, "examples", "kitchen_sink", "page.ree"), "<main><star-rating label='Rating'></star-rating></main>");
				// No precompile: the first render globs the views tree and registers the tag.
				expect(without_stamps(await engine.render("examples/kitchen_sink/page"))).toBe("<main><div class='stars'>Rating</div></main>");
				expect(engine.component_paths.get("star-rating")).toBe("examples/kitchen_sink/star-rating");
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});

		test("native custom elements without a component file stay passthrough (negative cache)", with_temp_dir(async (_dir, engine) => {
			const result = await engine.render_string("<toasts-area>content</toasts-area>");
			expect(result).toBe("<toasts-area>content</toasts-area>");
			// The miss is cached - a second render must not re-glob.
			expect(engine.component_misses.has("toasts-area")).toBe(true);
		}));

		test("kitchen_sink page renders <star-rating> from its route subfolder", async () => {
			// The real project layout + kitchen-sink page, rendered with the
			// minimal props layout.test.ts proves works. star-rating lives in
			// <main app>/examples/kitchen_sink/, so this exercises the routes-tree
			// ReeTag fallback end-to-end (components/ has no star-rating.ree).
			const routes_dir = join(process.cwd(), MAIN_APP);
			const engine = new TE({ views: routes_dir, cache: false, ext: ".ree", helper_names: DEFAULT_HELPER_NAMES });
			const props = {
				locale: "en-us",
				is_dev: false,
				version: "test",
				site_name: "Test",
				year: 2026,
				nav_groups: [],
				active_locales: [],
				locale_names: {},
				user: null,
				toasts: [],
				collapsed_nav_modules: [],
				path_locale: null,
				locale_preferred: null,
				dark_mode: false,
				theme_class: "",
				translations: {
					ui: { title: "Kitchen Sink", description: "All the widgets" },
					nav_auth: { login: "Login" },
					errors: {},
					labels: {},
					descriptions: {},
					messages: {},
				},
			};
			const rendered = await engine.render("examples/kitchen_sink/kitchen_sink", { ...props, helpers: create_template_helpers(props) });
			const html = without_stamps(rendered);
			// The star-rating widget output (moved component, resolved via the routes tree):
			expect(html).toContain('<input type="hidden" name="rating" data-rating-hidden value="0" />');
			expect(html).toContain("data-rating-star=\"1\"");
			expect(html).toContain("★");
			// And the layout still renders around it:
			expect(html).toContain('<html lang="en-US"');
		});

		test("precompile covers mounted route modules", with_temp_dir(async (dir) => {
			const module_root = join(dirname(dir), "marketplace", "studio");
			mkdirSync(module_root, { recursive: true });
			writeFileSync(join(module_root, "index.ree"), "<h1>{= props.title }</h1>");
			const engine = new TE({ views: dir, cache: true, ext: ".ree", route_module_mounts: [{ module_code: "studio", module_root }] });
			await precompile_templates(engine);
			expect(engine.compiled_cache["studio/index"]).toBeDefined();
			expect(await engine.render("studio/index", { title: "S" })).toBe("<h1>S</h1>");
		})); test("module ReeTag resolves with the template globbed before the component", with_temp_dir(async (dir) => {
			// The template sorts before the component it uses in glob order
			// (a-index.ree < zz/my-chip.ree). The two-pass index registers the
			// tag before any compile; even without it, the dev self-heal glob
			// would find the component - this locks in the behavior either way.
			const module_root = join(dirname(dir), "marketplace", "studio");
			mkdirSync(join(module_root, "zz"), { recursive: true });
			writeFileSync(join(module_root, "a-index.ree"), "<main><my-chip label='X'></my-chip></main>");
			writeFileSync(join(module_root, "zz", "my-chip.ree"), "<b>{= props.attributes.label }</b>");
			const engine = new TE({ views: dir, cache: true, ext: ".ree", route_module_mounts: [{ module_code: "studio", module_root }] });
			await precompile_templates(engine);
			expect(engine.component_paths.get("my-chip")).toBe("studio/zz/my-chip");
			expect(await engine.render("studio/a-index")).toBe("<main><b>X</b></main>");
		}));

		test("prod precompile negative-caches native elements (index is authoritative)", with_temp_dir(async (dir) => {
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "page.ree"), "<toasts-area>x</toasts-area>");
			await precompile_templates(engine);
			expect(engine.component_misses.has("toasts-area")).toBe(true);
			expect(await engine.render("page")).toBe("<toasts-area>x</toasts-area>");
		}));

		test("clear_cache clears negative component lookups", with_temp_dir(async (dir) => {
			const engine = make_engine(dir); // dev
			await engine.render_string("<toasts-area>x</toasts-area>");
			expect(engine.component_misses.has("toasts-area")).toBe(true);
			engine.clear_cache();
			expect(engine.component_misses.has("toasts-area")).toBe(false);
		})); test("precompile throws on compile errors (fail loud at boot)", with_temp_dir(async (dir) => {
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "ok.ree"), "fine");
			writeFileSync(join(dir, "broken.ree"), "{#if props.x}unclosed");
			await expect(precompile_templates(engine)).rejects.toThrow(/failed to compile[\s\S]*broken\.ree/);
		}));

		test("precompile in dev builds the registry only (no compile cache)", with_temp_dir(async (dir) => {
			const engine = make_engine(dir); // cache: false
			writeFileSync(join(dir, "t.ree"), "v1");
			await precompile_templates(engine);
			expect(engine.compiled_cache["t"]).toBeUndefined();
			expect(await engine.render("t")).toBe("v1");
			writeFileSync(join(dir, "t.ree"), "v2");
			expect(await engine.render("t")).toBe("v2"); // dev re-reads every render
		}));

		test("render still works after clear_cache (recompiles lazily)", with_temp_dir(async (dir) => {
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "t.ree"), "v1");
			await precompile_templates(engine);
			expect(await engine.render("t")).toBe("v1");
			engine.clear_cache();
			expect(await engine.render("t")).toBe("v1"); // disk path recompiles + re-caches
			expect(engine.compiled_cache["t"]).toBeDefined();
		})); test("precompile is idempotent", with_temp_dir(async (dir) => {
			const engine = new TE({ views: dir, cache: true, ext: ".ree" });
			writeFileSync(join(dir, "t.ree"), "x");
			await precompile_templates(engine);
			const count = Object.keys(engine.compiled_cache).length;
			const again = await precompile_templates(engine);
			expect(again.total).toBe(1);
			expect(Object.keys(engine.compiled_cache).length).toBe(count);
			expect(await engine.render("t")).toBe("x");
		}));

		test("precompiled alias include resolves locale variants via the raw index", async () => {
			const project_root = mkdtempSync(join(tmpdir(), "reepolee-test-"));
			const dir = join(project_root, "routes");
			const components_dir = join(project_root, "components");
			mkdirSync(dir, { recursive: true });
			mkdirSync(components_dir, { recursive: true });
			try {
				const engine = new TE({ views: dir, cache: true, ext: ".ree" });
				writeFileSync(join(dir, "page.ree"), "<main>{#include(\"$components/partial\", props.inc)}</main>");
				writeFileSync(join(components_dir, "partial.ree"), "<p>Base</p>");
				writeFileSync(join(components_dir, "partial.sl-si.ree"), "<p>Pozdrav</p>");
				await precompile_templates(engine);
				expect(await engine.render("page", { locale: "sl-si", inc: {} })).toBe("<main><p>Pozdrav</p></main>");
				expect(await engine.render("page", { locale: "en-us", inc: {} })).toBe("<main><p>Base</p></main>");
			} finally {
				rmSync(project_root, { recursive: true, force: true });
			}
		});
	});
});
