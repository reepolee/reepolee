/**
 * Synthetic BREAD generator.
 *
 * Writes the usual schema files from a developer-provided schema, then runs
 * the standard CRUD generation phases without consulting the DDL cache.
 * `create_bread` produces a single-content resource; `create_localized_bread`
 * produces one whose store is expected to hold content per locale. Neither
 * produces a `sql.ts` - both replace it with a hand-written `store.ts` stub
 * (`Item`/`RESOURCE_NAME`) since there is no table behind the resource for
 * the shared CRUD pipeline's generated SQL to query.
 */

import { join } from "node:path";

import { normalize_prefix } from "$lib/route";
import { notify_server_reload } from "$lib/server_notify";
import { db_type } from "$lib/resolve_db_type";
import { default_locale } from "$config/supported_locales";

import { generate_fields_object } from "../schema/field_generator";
import { write_table_file, write_table_generated_file, write_translation_files, write_validation_file } from "../schema/file_writer";
import { MySQLTypeMapper } from "../schema/mysql/mysql_type_mapper";
import { SQLiteTypeMapper } from "../schema/sqlite/sqlite_type_mapper";
import type { FormFieldDef, SyntheticSchema } from "../schema/types";
import { sync_single_namespace } from "../translate_namespace";
import { field_interface_prop } from "./helpers";
import { create_safe_writer, format_dirs, format_file, type SafeWriter, type WriteStatus } from "./file_writer";
import { generate_crud_files, sync_crud_translations, sync_nav_prefix_title, sync_nav_translations, sync_validation_translations, update_routes_ts } from "./main";
import { load_table_schema } from "./schema_reader";
import { stamp_generated_ree_hashes } from "./ree_hash";
import { apply_template } from "./template_substitutor";
import type { FieldDef } from "./types";
import { MAIN_APP } from "$config/paths";

export interface CreateBreadOptions {
	prefix?: string;
	route_name?: string;
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	template_tags?: "flat" | "tags";
	force?: boolean;
	interactive?: boolean;
}

export interface CreateBreadResult {
	success: boolean;
	resource_name: string;
	route_url: string;
	route_dir: string;
	generated_files: string[];
	overwritten_files: string[];
	skipped_files: string[];
	store_status: WriteStatus | "unknown";
	store_implementation_required: boolean;
	translation_namespace: string;
	translation_seeded_keys: number;
}

function validate_synthetic_schema_shape(schema: SyntheticSchema): void {
	if (!schema.name) throw new Error("Synthetic schema name is required");
	if (schema.type !== "table") throw new Error("Synthetic schemas must have type: \"table\"");
	if (schema.foreign_keys.length > 0) throw new Error("Synthetic schemas do not support foreign keys");
	if (schema.has_view) throw new Error("Synthetic schemas do not support views");

	const primary_key_columns = schema.columns.filter((column) => column.is_primary_key);
	if (primary_key_columns.length !== 1 || primary_key_columns[0]?.name !== "id") {
		throw new Error("Synthetic schemas require exactly one primary-key column named \"id\"");
	}
}

// Field kinds that assume a real DB table exists somewhere: FK-linked option
// tables (tags, foreign_key-driven autocomplete) or upload plumbing (image,
// file) that has nowhere to write to without one. Not meaningful on a BREAD
// resource's synthetic schema.
const UNSUPPORTED_BREAD_FIELD_KINDS = new Set(["tags", "image", "file", "autocomplete"]);

function validate_bread_field_kinds(resource_name: string, fields: FormFieldDef[]): void {
	const offending = fields.filter((field) => UNSUPPORTED_BREAD_FIELD_KINDS.has(field.type));
	if (offending.length === 0) return;
	const details = offending.map((field) => `${field.name} (${field.type})`).join(", ");
	throw new Error(`${resource_name} has unsupported field kind(s) for a BREAD resource: ${details}. Change these columns' types.`);
}

async function write_bread_store(route_dir: string, resource_name: string, fields: FieldDef[], localized: boolean, safe_writer: SafeWriter): Promise<void> {
	const has_id_in_fields = fields.some((field) => field.name === "id");
	const interface_fields = has_id_in_fields
		? fields.filter((field) => field.name !== "id" && field.name !== "display" && field.name !== "option_display").map((field) => field_interface_prop(field)).join("\n")
		: ["\tid: number;", ...fields.filter((field) => field.name !== "display" && field.name !== "option_display").map((field) => field_interface_prop(field))].join("\n");

	const editable_fields = fields.filter((field) => field.name !== "id" && field.name !== "display" && field.name !== "option_display");
	const create_item_arg = `Omit<Item, "id">`;
	const update_item_arg = `Omit<Item, "id">`;

	const template_name = localized ? "store_localized.ts" : "store.ts";
	const template_path = join(process.cwd(), "generator", "templates", "bread", template_name);
	const template = await Bun.file(template_path).text();
	const content = apply_template(template, {
		"resource.exact": resource_name,
		"interface.fields": interface_fields,
		"store.id_type": "number",
		"store.create_item_arg": create_item_arg,
		"store.update_item_arg": update_item_arg,
	});

	await safe_writer(join(route_dir, "store.ts"), content);

	const custom_store_path = join(route_dir, "store.custom.ts");
	if (!(await Bun.file(custom_store_path).exists())) {
		await Bun.write(
			custom_store_path,
			"// Add custom store helpers here. This file is never overwritten by the generator.\n"
		);
		console.log(`✓ Generated ${custom_store_path}`);
	}

	// sql.ts / sql.custom.ts are written by the shared CRUD pipeline before this
	// step runs - remove them so the resource only ships the store.ts contract.
	const stray_sql_path = join(route_dir, "sql.ts");
	const stray_sql_custom_path = join(route_dir, "sql.custom.ts");
	if (await Bun.file(stray_sql_path).exists()) await Bun.file(stray_sql_path).delete();
	if (await Bun.file(stray_sql_custom_path).exists()) await Bun.file(stray_sql_custom_path).delete();
}

/**
 * Rewrite `index.ts`'s SQL-flavored identifiers to the store contract's
 * terms. `Record` is only renamed when it is NOT followed by `<` - that
 * excludes every use of TypeScript's builtin `Record<K, V>` utility type
 * (e.g. `Record<string, unknown>` in the JSON-response cast) and only
 * touches the plain named type imported from `./sql`/`./store`.
 */
function rewrite_index_ts_identifiers(content: string): string {
	return content
		.replaceAll(`from "./sql"`, `from "./store"`)
		.replaceAll(/\bRecord\b(?!<)/g, "Item")
		.replaceAll(/\bTABLE_NAME\b/g, "RESOURCE_NAME")
		.replaceAll(/\bget_record_by_id\b/g, "get_item_by_id")
		.replaceAll(/\bcreate_record\b/g, "create_item")
		.replaceAll(/\bupdate_record\b/g, "update_item")
		.replaceAll(/\bdelete_record\b/g, "delete_item")
		.replaceAll(/\bsearch_records\b/g, "search_items")
		.replaceAll(/result\.records\b/g, "result.items");
}

/**
 * Strip the locale-copy UI/route wiring that the shared pipeline adds when a
 * table has `localized: true` columns. Only used for the non-localized
 * `create_bread` variant - `create_localized_bread` keeps this wiring as-is
 * (just with the store.ts identifier rename applied).
 */
function strip_locale_copy_from_index_ts(content: string): string {
	let result = content;

	result = result.replace(
		/\n\t"\/blogs\/:id\/copy-locale": \{ POST: post_\w+_copy_locale \},/,
		""
	);
	result = result.replace(/"\/[\w-]+\/:id\/copy-locale": \{ POST: post_\w+_copy_locale \},\n/, "");
	result = result.replace(
		/\n\t"\/blogs\/:id\/generate-locale": \{ POST: post_\w+_generate_locale \},/,
		""
	);
	result = result.replace(/"\/[\w-]+\/:id\/generate-locale": \{ POST: post_\w+_generate_locale \},\n/, "");

	result = result.replace(
		/\n\/\*\*\n \* Copy one locale's values into another for a single record\.[\s\S]*?\nexport async function post_\w+_copy_locale\([\s\S]*?\n\}\n/,
		"\n"
	);
	result = result.replace(
		/\n\/\*\*\n \* AI-generate a first-draft translation of one record's localized fields\.[\s\S]*?\nexport async function post_\w+_generate_locale\([\s\S]*?\n\}\n/,
		"\n"
	);

	result = result.replace(/\n\s*const locale_rows = await get_locale_rows\([\s\S]*?;\n\s*const notices = stale_copy_notices\([\s\S]*?;\n\s*const localization = build_localization_props\([\s\S]*?\);\n/, "\n");
	result = result.replaceAll(/\n\s*localization,/g, "");
	result = result.replaceAll(/\n\s*localization: build_localization_props\([\s\S]*?\}\),/g, "");
	result = result.replaceAll(/,\s*ctx\.locale\)/g, ")");
	result = result.replaceAll(/,\s*ctx\.locale,/g, ",");

	result = result.replace(/\n\s*const localized_inputs = parse_localized_form\([\s\S]*?;\n\s*const localized_values = localized_input_form_state\([\s\S]*?;\n/, "\n");
	result = result.replace(/\s*const localized_errors = validate_localized_inputs\([\s\S]*?;\n/, "\n");
	result = result.replaceAll(/ \|\| !valid_data \|\| Object\.keys\(localized_errors\)\.length > 0/g, " || !valid_data");
	result = result.replace(/\n\s*await save_locale_values\([\s\S]*?;\n/, "\n");

	result = result.replaceAll(/\n\s*const LOCALIZED_FIELDS = \[[\s\S]*?\] as const;\n\s*const LOCALIZED_FIELD_NAMES = LOCALIZED_FIELDS\.map\([\s\S]*?\);\n/g, "\n");

	result = result
		.replace(/import \{ enqueue \} from "\$queue\/index";\n/, "")
		.replace(/import \{ copy_localized_values, generate_localized_values, get_locale_rows, stale_copy_notices \} from "\$lib\/localized_copy";\n/, "")
		.replace(/import \{ build_localization_props, localized_input_form_state, parse_copy_request, parse_generate_request, parse_localized_form, validate_localized_inputs \} from "\$lib\/localized_form";\n/, "")
		.replace(/import \{ locales \} from "\$config\/supported_locales";\n/, "")
		.replace(/import \{ invalidate_all_locales, save_locale_values \} from "\$lib\/locale_write";\n/, "");

	return result;
}

/** Strip localized editor components, leaving their plain field markup in place. */
function strip_locale_tabs_from_form_ree(content: string): string {
	const without_tabs = content.replace(
		/<localized-field-tabs field="[^"]*" label="[^"]*" localization="\{= props\.localization \}">\n([\s\S]*?)\n\n\t\t\t<\/localized-field-tabs>/g,
		(_full, inner: string) => inner
	);
	return without_tabs.replace(
		/<localized-input-text\b([^>]*)\blocalization="\{= props\.localization \}"([^>]*)><\/localized-input-text>/g,
		(_full, before: string, after: string) => `<input-text${before}${after}></input-text>`,
	);
}

async function create_bread_resource(schema: SyntheticSchema, options: CreateBreadOptions, localized: boolean): Promise<CreateBreadResult> {
	const { clean: initial_clean_prefix, route: initial_route_prefix } = normalize_prefix(options.prefix ?? "");
	const initial_directory_name = options.route_name || schema.name;
	const initial_route_dir = initial_clean_prefix ? join(process.cwd(), MAIN_APP, initial_clean_prefix, initial_directory_name) : join(process.cwd(), MAIN_APP, initial_directory_name);
	const initial_route_url = `${initial_route_prefix}/${initial_directory_name}`;
	const initial_namespace = initial_clean_prefix ? `${initial_clean_prefix}.${initial_directory_name}` : initial_directory_name;
	try {
		validate_synthetic_schema_shape(schema);
		const { clean: clean_prefix, route: route_prefix } = normalize_prefix(options.prefix ?? "");
		const route_name = options.route_name ?? "";
		const directory_name = route_name || schema.name;
		const route_dir = clean_prefix ? join(process.cwd(), MAIN_APP, clean_prefix, directory_name) : join(process.cwd(), MAIN_APP, directory_name);
		const type_mapper_map = new Map([
			["mysql", () => new MySQLTypeMapper()],
			["sqlite", () => new SQLiteTypeMapper()],
		]);
		const type_mapper = type_mapper_map.get(db_type)?.();
		if (!type_mapper) throw new Error(`Unsupported db_type: ${db_type}`);
		const directly_written_paths = [
			join(route_dir, "schema.generated.ts"),
			join(route_dir, "config.ts"),
			join(route_dir, "validation_server.ts"),
		];
		const existing_direct_paths = new Set<string>();
		for (const direct_path of directly_written_paths) {
			if (await Bun.file(direct_path).exists()) existing_direct_paths.add(direct_path);
		}
		const custom_store_path = join(route_dir, "store.custom.ts");
		const custom_store_existed = await Bun.file(custom_store_path).exists();

		const resolved_fields = Object.values(generate_fields_object(schema, type_mapper));
		validate_bread_field_kinds(schema.name, resolved_fields);

		const table_column_map = new Map<string, string[]>();
		const table_indexes = new Map<string, Set<string>>();
		await write_table_generated_file(route_dir, schema, type_mapper, table_column_map, table_indexes);
		await write_table_file({
			dir: route_dir,
			schema_obj: schema,
			type_mapper,
			all_tables_columns: table_column_map,
			all_tables_indexes: table_indexes,
			pagination_strategy: options.pagination_strategy,
			render_strategy: options.render_strategy,
			template_tags: options.template_tags,
			localize_content: localized,
		});
		await write_validation_file(route_dir, schema, type_mapper, table_column_map, table_indexes);
		await write_translation_files(route_dir, schema, type_mapper, table_column_map, table_indexes, route_name);

		const meta = await load_table_schema(schema.name, {
			clean_prefix,
			route_prefix,
			parent_cli_table: "",
			route_name,
			pagination_strategy: options.pagination_strategy,
			template_tags: options.template_tags,
			skip_cache: true,
		});
		if (options.render_strategy) meta.render_strategy = options.render_strategy;

		const safe_write = create_safe_writer(options.force ?? false, options.interactive);
		await generate_crud_files(meta, safe_write);

		await write_bread_store(route_dir, schema.name, meta.fields, localized, safe_write);

		let index_ts = await Bun.file(join(route_dir, "index.ts")).text();
		index_ts = rewrite_index_ts_identifiers(index_ts);
		if (!localized) index_ts = strip_locale_copy_from_index_ts(index_ts);
		await Bun.write(join(route_dir, "index.ts"), index_ts);

		if (!localized) {
			const form_ree_path = join(route_dir, "form.ree");
			if (await Bun.file(form_ree_path).exists()) {
				const form_ree = await Bun.file(form_ree_path).text();
				await Bun.write(form_ree_path, strip_locale_tabs_from_form_ree(form_ree));
			}
		}

		const route_result = await update_routes_ts({
			table_name: schema.name,
			crud_name: meta.crud_name,
			clean_prefix,
			route_prefix,
			parent_cli_table: "",
			is_nested: false,
			route_name: meta.route_name,
		});

		await sync_nav_translations(schema.name, clean_prefix, false, meta.route_name);
		await sync_nav_prefix_title(clean_prefix, false);
		if (clean_prefix) meta.changed_dirs.add(join(MAIN_APP, clean_prefix));
		await sync_crud_translations(schema.name, meta.route_dir, meta.fields, false, undefined, meta.v_fields);
		await sync_validation_translations(schema.name, meta.route_dir, meta.fields, meta.foreign_keys);
		const namespaces_to_sync = new Set<string>([initial_namespace]);
		if (clean_prefix) namespaces_to_sync.add(clean_prefix);
		for (const namespace of namespaces_to_sync) {
			await sync_single_namespace(namespace, false);
		}
		const { flatten_translation_object, read_namespace_file } = await import("$lib/translation_files");
		const translation_obj = await read_namespace_file(initial_namespace, default_locale);
		const translation_seeded_keys = flatten_translation_object(translation_obj).length;
		await format_dirs(meta.changed_dirs);
		await stamp_generated_ree_hashes(route_dir);

		if (route_result.routes_content) {
			const routes_path = join(process.cwd(), MAIN_APP, "routes.ts");
			await Bun.write(routes_path, route_result.routes_content);
			await format_file(routes_path);
		}

		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		await notify_server_reload();
		const relative_outcomes: Array<{ path: string; status: WriteStatus; }> = [];
		for (const outcome of safe_write.outcomes) {
			const outcome_exists = await Bun.file(outcome.path).exists();
			if (!outcome_exists) continue;
			const relative_path = outcome.path.startsWith(process.cwd()) ? outcome.path.slice(process.cwd().length + 1).replaceAll("\\", "/") : outcome.path;
			relative_outcomes.push({ path: relative_path, status: outcome.status });
		}
		for (const direct_path of directly_written_paths) {
			const relative_path = direct_path.slice(process.cwd().length + 1);
			const normalized_path = relative_path.replaceAll("\\", "/");
			const status: WriteStatus = existing_direct_paths.has(direct_path) ? "overwritten" : "created";
			relative_outcomes.push({ path: normalized_path, status });
		}
		if (!custom_store_existed && await Bun.file(custom_store_path).exists()) {
			const relative_path = custom_store_path.slice(process.cwd().length + 1);
			relative_outcomes.push({ path: relative_path.replaceAll("\\", "/"), status: "created" });
		}
		const store_path = join(route_dir, "store.ts");
		const store_outcome = safe_write.outcomes.find((outcome) => outcome.path === store_path);
		const store_status = store_outcome?.status ?? "unknown";
		const store_implementation_required = store_status === "created" || store_status === "overwritten";
		console.log(`✓ Generated synthetic BREAD resource: ${schema.name}`);
		if (store_implementation_required) {
			console.log(`  Implement routes/${clean_prefix ? `${clean_prefix}/` : ""}${directory_name}/store.ts before using this resource - every function is a placeholder.`);
		}
		return {
			success: true,
			resource_name: schema.name,
			route_url: `${route_prefix}/${directory_name}`,
			route_dir: route_dir.replaceAll("\\", "/"),
			generated_files: relative_outcomes.filter((outcome) => outcome.status === "created").map((outcome) => outcome.path),
			overwritten_files: relative_outcomes.filter((outcome) => outcome.status === "overwritten").map((outcome) => outcome.path),
			skipped_files: relative_outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.path),
			store_status,
			store_implementation_required,
			translation_namespace: initial_namespace,
			translation_seeded_keys,
		};
	} catch (error) {
		console.error("Error:", error instanceof Error ? error.message : error);
		return {
			success: false,
			resource_name: schema.name,
			route_url: initial_route_url,
			route_dir: initial_route_dir.replaceAll("\\", "/"),
			generated_files: [],
			overwritten_files: [],
			skipped_files: [],
			store_status: "unknown",
			store_implementation_required: false,
			translation_namespace: initial_namespace,
			translation_seeded_keys: 0,
		};
	}
}

export async function create_bread_detailed(schema: SyntheticSchema, options: CreateBreadOptions = {}): Promise<CreateBreadResult> {
	return create_bread_resource(schema, options, false);
}

export async function create_localized_bread_detailed(schema: SyntheticSchema, options: CreateBreadOptions = {}): Promise<CreateBreadResult> {
	return create_bread_resource(schema, options, true);
}

/** Generate a non-localized BREAD resource: single content, no locale UI. */
export async function create_bread(schema: SyntheticSchema, options: CreateBreadOptions = {}): Promise<boolean> {
	const result = await create_bread_detailed(schema, options);
	return result.success;
}

/** Generate a BREAD resource whose store is expected to hold content per locale. */
export async function create_localized_bread(schema: SyntheticSchema, options: CreateBreadOptions = {}): Promise<boolean> {
	const result = await create_localized_bread_detailed(schema, options);
	return result.success;
}
