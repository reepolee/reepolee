import { describe, expect, mock, test } from "bun:test";

const saved_settings: Array<{ path: string; settings: Record<string, unknown>; }> = [];
const refreshed_routes: Array<Array<string | undefined>> = [];
const removed_routes: string[] = [];

mock.module("$config/db", () => ({ DB_CONNECTION_STRING: "" }));
mock.module("$config/paths", () => ({ MAIN_APP: "apps/main", MAIN_APP_POSIX: "apps/main" }));
mock.module("./lib/busy_state", () => ({
	GLOBAL_BUSY_KEY: "__global__",
	clear_busy: async () => {},
	get_busy: async () => null,
	set_busy: async () => true,
}));
mock.module("./lib/state", () => ({
	record_run: async (entry: { target: string; }) => entry.target,
	update_run: async () => {},
}));
mock.module("$generator/reeman/utils/route_scan", () => ({
	discover_routes_with_schema: () => [{ table: "metrics", prefix: "admin", url: "/admin/metrics" }],
}));
mock.module("$generator/schema/write_table", () => ({
	update_table_file_settings: async (path: string, settings: Record<string, unknown>) => { saved_settings.push({ path, settings }); },
}));
mock.module("$generator/reeman/refresh_crud", () => ({
	refresh_crud_fields_only: async (...args: Array<string | undefined>) => { refreshed_routes.push(args); return true; },
}));
mock.module("$generator/reeman/remove_route", () => ({
	list_removable_routes: async () => [
		{ url: "/admin/metrics", module: "admin" },
		{ url: "/admin/metrics/metric_enum_values", module: "admin" },
	],
	remove_route: async (url: string) => { removed_routes.push(url); },
}));

const { action_add_nested_children, action_bulk_remove_route, action_save_route_settings, build_bulk_command_args, spawn_bulk_action } = await import("./actions");

describe("build_bulk_command_args", () => {
	test("rejects nested generation without a selected child", async () => {
		const result = await action_add_nested_children({
			parent_table: "metrics",
			parent_url: "/metrics",
			children: [],
			pagination: "offset",
			render_strategy: "load",
			template_tags: "flat",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Select at least one child table.");
	});

	test("runs all selected tables through one sequential bulk command", () => {
		const args = build_bulk_command_args(["metrics", "readings"], {
			force: true,
			prefix: "admin",
			pagination: "cursor",
			render_strategy: "stream",
			template_tags: "tags",
		});

		expect(args).toEqual([
			"run",
			"reeman",
			"bulk",
			"metrics",
			"readings",
			"--force",
			"--prefix",
			"admin",
			"--pagination",
			"cursor",
			"--render-strategy",
			"stream",
			"--template-tags",
			"tags",
		]);
	});

	test("uses the CLI route-name flag", () => {
		const args = build_bulk_command_args(["readings"], {
			prefix: "user",
			route_name: "readings_for_user",
		});

		expect(args).toContain("--route-name");
		expect(args).toContain("readings_for_user");
		expect(args).not.toContain("--route_name");
	});

	test("spawns one bulk process for all selected tables", async () => {
		const original_spawn = Bun.spawn;
		const spawned_commands: string[][] = [];
		const empty_stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
		(Bun as { spawn: typeof Bun.spawn; }).spawn = ((command: string[]) => {
			spawned_commands.push(command);
			return {
				stdout: empty_stream(),
				stderr: empty_stream(),
				exited: Promise.resolve(0),
				unref: () => {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		try {
			const started = await spawn_bulk_action(["metrics", "readings"], { prefix: "admin" });
			expect(started).toEqual(["metrics", "readings"]);
			expect(spawned_commands).toEqual([[
				"bun",
				"run",
				"reeman",
				"bulk",
				"metrics",
				"readings",
				"--prefix",
				"admin",
			]]);
		} finally {
			(Bun as { spawn: typeof Bun.spawn; }).spawn = original_spawn;
		}
	});

	test("saves route settings before refreshing CRUD", async () => {
		saved_settings.length = 0;
		refreshed_routes.length = 0;

		const result = await action_save_route_settings({
			url: "/admin/metrics",
			pagination: "cursor",
			render_strategy: "stream",
			template_tags: "tags",
			refresh: true,
		});

		expect(result.ok).toBe(true);
		expect(saved_settings).toHaveLength(1);
		const saved_setting = saved_settings[0]!;
		const normalized_path = saved_setting.path.replaceAll("\\", "/");
		expect(normalized_path).toContain("apps/main/admin/metrics/config.ts");
		expect(saved_setting.settings).toEqual({
			pagination_strategy: "cursor",
			render_strategy: "stream",
			template_tags: "tags",
			grid_columns: undefined,
			grid_column_definitions: undefined,
			form_hints: undefined,
			form_details: undefined,
		});
		expect(refreshed_routes).toEqual([["metrics", "admin", undefined, undefined]]);
	});

	test("removes a selected parent once when its nested child is also selected", async () => {
		removed_routes.length = 0;

		const result = await action_bulk_remove_route({
			urls: ["/admin/metrics", "/admin/metrics/metric_enum_values"],
		});

		expect(result.ok).toBe(true);
		expect(removed_routes).toEqual(["/admin/metrics"]);
		expect(result.output).not.toContain("Skipped /admin/metrics/metric_enum_values");
	});
});
