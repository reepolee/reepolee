import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { filter_mcp_tools } from "./capabilities";
import { create_safe_writer } from "$generator/crud/file_writer";
import { apply_template } from "$generator/crud/template_substitutor";
import { get_route_detail } from "./project";
import { MAIN_APP_SEGMENTS } from "$config/paths";
import { ROUTES_DIR } from "./paths";

let temporary_dir: string | null = null;

afterEach(() => {
	if (!temporary_dir) return;
	rmSync(temporary_dir, { recursive: true, force: true });
	temporary_dir = null;
});

describe("MCP capabilities", () => {
	test("keeps mutation tools out of the read-only profile", () => {
		const tools = [{ name: "list_routes" }, { name: "run_generator" }, { name: "add_translations" }];
		const read_only_tools = filter_mcp_tools(tools, "false");
		const mutation_tools = filter_mcp_tools(tools, "true");
		expect(read_only_tools.map((tool) => tool.name)).toEqual(["list_routes"]);
		expect(mutation_tools).toEqual(tools);
	});
});

describe("safe file writer", () => {
	test("reports created, skipped, and overwritten outcomes", async () => {
		temporary_dir = mkdtempSync(join(tmpdir(), "reepolee-mcp-writer-"));
		const file_path = join(temporary_dir, "output.txt");
		const create_writer = create_safe_writer(false, false);
		await create_writer(file_path, "first");
		await create_writer(file_path, "second");
		const overwrite_writer = create_safe_writer(true, false);
		await overwrite_writer(file_path, "third");
		expect(create_writer.outcomes.map((outcome) => outcome.status)).toEqual(["created", "skipped"]);
		expect(overwrite_writer.outcomes.map((outcome) => outcome.status)).toEqual(["overwritten"]);
		expect(await Bun.file(file_path).text()).toBe("third");
	});
});

describe("template substitution", () => {
	test("allows only explicitly deferred placeholders", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const result = apply_template("__known__ __later__ __typo__", { known: "ready" }, { deferred: ["later"] });
		expect(result).toBe("ready __later__ __typo__");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("__typo__");
		expect(String(warn.mock.calls[0]?.[0])).not.toContain("__later__");
		warn.mockRestore();
	});
});

describe("BREAD route inspection", () => {
	test("reports store-backed files and the local data path", async () => {
		// blog2 was removed from the template; the bread detection path is
		// exercised with a minimal in-repo fixture instead (same shape
		// create_bread emits: store.ts + schema.generated.ts + form.ree).
		const fixture_dir = join(ROUTES_DIR, `bread-fixture-${process.pid}`);
		temporary_dir = fixture_dir;
		mkdirSync(fixture_dir, { recursive: true });
		writeFileSync(join(fixture_dir, "index.ts"), "export default {};\n");
		writeFileSync(join(fixture_dir, "form.ree"), "<form></form>\n");
		writeFileSync(join(fixture_dir, "schema.generated.ts"), "export type Item = { id: string };\n");
		// One ".." per app-root segment, plus one for the fixture folder itself,
		// so the store's data path lands on the project root wherever the main
		// app tree lives.
		const up_to_project_root = Array(MAIN_APP_SEGMENTS.length + 1).fill('".."').join(", ");
		writeFileSync(join(fixture_dir, "store.ts"), `const data_path = join(import.meta.dir, ${up_to_project_root}, "data", "blog2.json");\n`);

		const detail = await get_route_detail(`/${basename(fixture_dir)}`);
		expect(detail.exists).toBeTrue();
		expect(detail.type).toBe("bread");
		expect(detail.storage).toBe("store");
		expect(detail.files).toContain("store.ts");
		expect(detail.files).toContain("schema.generated.ts");
		expect(detail.data_path).toBe("data/blog2.json");
	});
});
