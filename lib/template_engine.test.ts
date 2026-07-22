import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { default_language } from "$config/supported_languages";

const TE = (await import("./template_engine")).default;

function make_engine(views: string) { return new TE({ views, cache: false, ext: ".ree" }); }

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
				expect(result).toBe("<main><header>Hi</header></main>");
			})
		);

		test("nested includes work (include within include)", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "_shared.ree"), "<small>{= props.text }</small>");
			writeFileSync(join(dir, "_section.ree"), "<section>{#include(\"_shared\", props.inner )}</section>");
			writeFileSync(join(dir, "page.ree"), "<div>{#include(\"_section\", props.sec )}</div>");
			const result = await engine.render("page", { sec: { inner: { text: "nested" } } });
			expect(result).toBe("<div><section><small>nested</small></section></div>");
		}));

		test(
			"relative include path ./ works",
			with_temp_dir(async (dir, engine) => {
				mkdirSync(join(dir, "partials"), { recursive: true });
				writeFileSync(join(dir, "partials", "_footer.ree"), "<footer>{= props.text }</footer>");
				// The include path is relative to the template's directory
				writeFileSync(join(dir, "page.ree"), "<main>{#include(\"./partials/_footer\", props.footerData )}</main>");
				const result = await engine.render("page", { footerData: { text: "Footer" } });
				expect(result).toBe("<main><footer>Footer</footer></main>");
			})
		);
		test(
			"localized include fallback works",
			with_temp_dir(async (dir, engine) => {
				// Create language-specific templates and a default
				writeFileSync(join(dir, `_header.${default_language}.ree`), "<header>Hello</header>");
				writeFileSync(join(dir, "_header.ree"), "<header>Default</header>");
				// Use props.emptyData to reference empty data instead of {} which confuses the parser
				writeFileSync(join(dir, "page.ree"), "{#include(\"_header\", props.emptyData )}");

				const default_variant = await engine.render("page", { lang: default_language, emptyData: {} });
				expect(default_variant).toBe("<header>Hello</header>");

				const missing_language = default_language === "fallback" ? "alternate" : "fallback";
				const fallback = await engine.render("page", { lang: missing_language, emptyData: {} });
				expect(fallback).toBe("<header>Hello</header>");
			})
		);
	});

	describe("layouts", () => test("{#layout} wraps content - body must use {~ ... } (unescaped) since it contains HTML", with_temp_dir(async (dir, engine) => {
		writeFileSync(join(dir, "_layout.ree"), "<html><body>{~ props.body }</body></html>");
		writeFileSync(join(dir, "child.ree"), "{#layout(\"_layout\")}<h1>Content</h1>");
		const result = await engine.render("child");
		expect(result).toBe("<html><body><h1>Content</h1></body></html>");
	})));

	describe("components", () => {
		test("ReeTag <tag-name> includes from components/ dir", with_temp_dir(async (dir, engine) => {
			const components_dir = join(dirname(dir), "components");
			mkdirSync(components_dir, { recursive: true });
			writeFileSync(join(components_dir, "my-badge.ree"), "<span class='badge'>{= props.attributes.label }</span>");
			writeFileSync(join(dir, "page.ree"), "<div><my-badge label='New'></my-badge></div>");
			const result = await engine.render("page");
			expect(result).toBe("<div><span class='badge'>New</span></div>");
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
		test("load_localized falls back through lang chain", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "page.sl.ree"), "Pozdravljeni!");
			writeFileSync(join(dir, "page.en.ree"), "Hello!");
			const sl = await engine.load_localized("page", "sl");
			expect(sl.content).toContain("Pozdravljeni");
			const en = await engine.load_localized("page", "en");
			expect(en.content).toContain("Hello");
		}));

		test("load_localized falls back to default lang then bare file", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "page.ree"), "Default fallback");
			const result = await engine.load_localized("page", "de");
			expect(result.content).toContain("Default fallback");
		}));

		test("render uses language-specific template when available", with_temp_dir(async (dir, engine) => {
			writeFileSync(join(dir, "greet.en.ree"), "Hello");
			writeFileSync(join(dir, "greet.sl.ree"), "Zdravo");
			writeFileSync(join(dir, "greet.ree"), "Hi");
			const en = await engine.render("greet", { lang: "en" });
			expect(en).toBe("Hello");
			const sl = await engine.render("greet", { lang: "sl" });
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
});
