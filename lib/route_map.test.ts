import { beforeAll, describe, expect, test } from "bun:test";

const rm = await import("./route_map");

describe("route_map", () => {
	// Sample data for building route maps
	const translations: Record<string, any> = {
		en: {
			home: { route_name: "Home" },
			about: { route_name: "About Us" },
			admin: { users: { route_name: "Users" } },
		},
		sl: {
			home: { route_name: "Domov" },
			about: { route_name: "O nas" },
			admin: { users: { route_name: "Uporabniki" } },
		},
	};

	const routes = {
		"/": {} as any,
		"/home": {} as any,
		"/about": {} as any,
		"/admin/users": {} as any,
		"/api/data": {} as any,
		"/posts/:id": {} as any,
	};

	const languages = ["en", "sl"] as const;

	describe("build_route_maps", () => {
		test("root always maps to itself in all languages", () => {
			rm.build_route_maps(translations, routes, languages);
			const maps = rm.get_route_maps();
			for (const lang of languages) {
				const lang_maps = maps.by_lang.get(lang)!;
				expect(lang_maps.localized_to_canonical.get("/")).toBe("/");
				expect(lang_maps.canonical_to_localized.get("/")).toBe("/");
			}
		});

		test("maps translated paths for each language", () => {
			rm.build_route_maps(translations, routes, languages);
			const maps = rm.get_route_maps();

			// English
			const en = maps.by_lang.get("en")!;
			expect(en.canonical_to_localized.get("/home")).toBe("/home");
			expect(en.canonical_to_localized.get("/about")).toBe("/about-us");
			expect(en.canonical_to_localized.get("/admin/users")).toBe("/admin/users");

			// Slovenian
			const sl = maps.by_lang.get("sl")!;
			expect(sl.canonical_to_localized.get("/home")).toBe("/domov");
			expect(sl.canonical_to_localized.get("/about")).toBe("/o-nas");
			expect(sl.canonical_to_localized.get("/admin/users")).toBe("/admin/uporabniki");
		});

		test("maps localized paths back to canonical", () => {
			rm.build_route_maps(translations, routes, languages);
			const maps = rm.get_route_maps();

			const sl = maps.by_lang.get("sl")!;
			expect(sl.localized_to_canonical.get("/domov")).toBe("/home");
			expect(sl.localized_to_canonical.get("/o-nas")).toBe("/about");
			expect(sl.localized_to_canonical.get("/admin/uporabniki")).toBe("/admin/users");
		});

		test("non-translated routes get identity mapping", () => {
			const no_translations = { en: {}, sl: {} };
			rm.build_route_maps(no_translations, routes, languages);
			const maps = rm.get_route_maps();

			for (const lang of languages) {
				const lang_maps = maps.by_lang.get(lang)!;
				expect(lang_maps.canonical_to_localized.get("/home")).toBe("/home");
				expect(lang_maps.canonical_to_localized.get("/about")).toBe("/about");
			}
		});

		test("handles missing language translations", () => {
			const partial = { en: { home: { route_name: "Home" } } };
			rm.build_route_maps(partial, { "/": {} as any, "/home": {} as any }, languages);
			const maps = rm.get_route_maps();

			// lang with no translations uses identity mapping
			const sl = maps.by_lang.get("sl")!;
			expect(sl.canonical_to_localized.get("/home")).toBe("/home");
		});

		test("handles dynamic segments (:param)", () => {
			rm.build_route_maps(translations, routes, languages);
			const maps = rm.get_route_maps();

			const en = maps.by_lang.get("en")!;
			expect(en.canonical_to_localized.get("/posts/:id")).toBe("/posts/:id");

			// Dynamic patterns are registered
			expect(maps.localized_patterns.get("en")).toContain("/posts/:id");
		});
	});

	describe("get_route_maps", () => test("returns maps after build_route_maps is called", () => {
		rm.build_route_maps({ en: {} }, { "/": {} as any }, ["en"]);
		const maps = rm.get_route_maps();
		expect(maps).toBeDefined();
		expect(maps.by_lang.has("en")).toBe(true);
	}));

	describe("reload_route_maps", () => test("rebuilds maps with new translations", () => {
		rm.build_route_maps(translations, routes, languages);

		// Reload with different translations
		const new_translations = {
			en: { home: { route_name: "New Home" } },
			sl: { home: { route_name: "Nov Domov" } },
		};
		rm.reload_route_maps(new_translations, routes, languages);

		const maps = rm.get_route_maps();
		const en = maps.by_lang.get("en")!;
		expect(en.canonical_to_localized.get("/home")).toBe("/new-home");
	}));

	describe("resolve_canonical", () => {
		beforeAll(() => rm.build_route_maps(translations, routes, languages));

		test("resolves exact localized path", () => {
			const result = rm.resolve_canonical("/domov", "sl");
			expect(result).toBe("/home");
		});

		test("returns null for unknown language", () => expect(rm.resolve_canonical("/domov", "de")).toBeNull());

		test("returns null for unresolvable path", () => expect(rm.resolve_canonical("/nonexistent", "sl")).toBeNull());

		test("resolves dynamic pattern paths (e.g., /posts/123 -> /posts/:id)", () => {
			const result = rm.resolve_canonical("/posts/123", "en");
			expect(result).toBe("/posts/:id");
		});
	});

	describe("resolve_localized", () => {
		beforeAll(() => rm.build_route_maps(translations, routes, languages));

		test("resolves exact canonical path", () => {
			const result = rm.resolve_localized("/home", "sl");
			expect(result).toBe("/domov");
		});

		test("returns null for unknown language", () => expect(rm.resolve_localized("/home", "de")).toBeNull());

		test("resolves dynamic paths with actual values", () => {
			const result = rm.resolve_localized("/posts/123", "sl");
			expect(result).toBe("/posts/123");
		});

		test("returns null for unresolvable path", () => expect(rm.resolve_localized("/nonexistent", "sl")).toBeNull());
	});

	describe("detect_lang", () => {
		beforeAll(() => rm.build_route_maps(translations, routes, languages));

		test("detects Slovenian from a Slovenian-localized path", () => {
			const result = rm.detect_lang("/domov");
			expect(result).toBe("sl");
		});

		test("returns detected language for translated paths", () => {
			// /home is localized to /home in en and /domov in sl
			// So /home only matches English
			const result = rm.detect_lang("/home");
			expect(result).toBe("en");
		});

		test("returns null for non-localized paths (same in all languages)", () => {
			// /api/data has no route_name translation in any language,
			// so it maps to itself in all languages -> not unique -> null
			const result = rm.detect_lang("/api/data");
			expect(result).toBeNull();
		});

		test("returns null for unknown paths", () => {
			const result = rm.detect_lang("/unknown");
			expect(result).toBeNull();
		});

		test("detects from dynamic paths", () => {
			// With our translation setup, /posts/:id is identity-mapped everywhere
			// so it should be null (same in all langs)
			const result = rm.detect_lang("/posts/123");
			expect(result).toBeNull();
		});
	});

	describe("expand_route_aliases_from_maps", () => {
		beforeAll(() => rm.build_route_maps(translations, routes, languages));

		test("expands route table with aliases", () => {
			const handlers = {
				"/": async () => new Response("root"),
				"/home": async () => new Response("home"),
			};

			const expanded = rm.expand_route_aliases_from_maps(handlers, languages);
			expect(Object.keys(expanded)).toContain("/home");
			expect(Object.keys(expanded)).toContain("/"); // root preserved
		});

		test("does not add duplicate aliases", () => {
			const handlers = { "/": async () => new Response("root") };

			const expanded = rm.expand_route_aliases_from_maps(handlers, languages);
			// Should not have duplicates
			const keys = Object.keys(expanded);
			expect(new Set(keys).size).toBe(keys.length);
		});
	});

	describe("find_route_name_in_tree - via build_route_maps", () => test("discovers route_name in deeply nested translation tree", () => {
		const nested_translations = { sl: { system: { auth: { invite: { route_name: "Povabilo" } } } } };
		const nested_routes = { "/": {} as any, "/invite": {} as any };
		rm.build_route_maps(nested_translations, nested_routes, ["sl"]);
		const maps = rm.get_route_maps();
		const sl = maps.by_lang.get("sl")!;
		// The route /invite should be localized to /povabilo
		expect(sl.canonical_to_localized.get("/invite")).toBe("/povabilo");
	}));

	describe("resolve_localized - pattern match with param values", () => {
		beforeAll(() => {
			// Build maps with a localized route that has dynamic segments
			const param_translations = { sl: { register: { route_name: "Registracija" } } };
			const param_routes = { "/": {} as any, "/register/:email/:code": {} as any };
			rm.build_route_maps(param_translations, param_routes, ["sl"]);
		});

		test("resolves localized path with multiple dynamic param values", () => {
			const result = rm.resolve_localized("/register/user@x.com/uuid-123", "sl");
			expect(result).toBe("/registracija/user@x.com/uuid-123");
		});

		test("returns null for mismatched segment length", () => {
			const result = rm.resolve_localized("/register/user@x.com", "sl");
			expect(result).toBeNull();
		});
	});

	describe("resolve_canonical - canonical pattern match fallback", () => {
		beforeAll(() => {
			// Build maps where a path with actual values could match canonical pattern
			const cm_translations = { en: {}, sl: {} };
			const cm_routes = { "/": {} as any, "/posts/:id": {} as any };
			rm.build_route_maps(cm_translations, cm_routes, ["en", "sl"]);
		});

		test("resolves canonical pattern from actual value path", () => {
			// /posts/123 has canonical pattern /posts/:id
			const result = rm.resolve_canonical("/posts/123", "en");
			expect(result).toBe("/posts/:id");
		});

		test("returns null for mismatched segments in canonical pattern fallback", () => {
			const result = rm.resolve_canonical("/posts/123/comments", "en");
			expect(result).toBeNull();
		});
	});
});

describe("slugify", () => {
	test("converts to lowercase", () => expect(rm.slugify("Hello World")).toBe("hello-world"));

	test("removes diacritics", () => expect(rm.slugify("čšž")).toBe("csz"));

	test("replaces ß with ss", () => expect(rm.slugify("Straße")).toBe("strasse"));

	test("replaces non-alphanumeric with hyphens", () => expect(rm.slugify("hello world!")).toBe("hello-world"));

	test("strips leading and trailing hyphens", () => {
		expect(rm.slugify("--hello--")).toBe("hello");
		expect(rm.slugify("---test---")).toBe("test");
	});

	test("preserves underscores", () => expect(rm.slugify("user_profile")).toBe("user_profile"));

	test("handles empty string", () => expect(rm.slugify("")).toBe(""));

	test("handles null/undefined", () => {
		expect(rm.slugify(null as any)).toBe("");
		expect(rm.slugify(undefined as any)).toBe("");
	});

	test("collapses multiple hyphens", () => expect(rm.slugify("hello   world")).toBe("hello-world"));

	test("handles multi-byte characters (non-Latin)", () => {
		const result = rm.slugify("日本語");
		expect(typeof result).toBe("string");
	});

	test("handles æ character", () => {
		const result = rm.slugify("Ærø");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});
});

describe("resolve_localized_path", () => {
	test("returns null for unmapped path", () => expect(rm.resolve_localized_path("/unknown", "sl")).toBeNull());

	test("returns null for exact path not in maps", () => expect(rm.resolve_localized_path("/nonexistent", "en")).toBeNull());
});
