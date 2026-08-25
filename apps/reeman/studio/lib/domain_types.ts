/**
 * Studio domain types - thin shim around the canonical DOMAIN_TYPES taxonomy.
 *
 * The canonical mappings live in config/domain_types/{sqlite,mysql}.ts and are
 * the single source of truth. This module just makes them available to the
 * studio UI with the HTML input badge from the generator's type mappers.
 */

import { BOOLEAN_PREFIXES, FILE_SUFFIXES, IMAGE_SUFFIXES } from "$config/db_structure";
import { DOMAIN_TYPES as SQLITE_DT } from "$config/domain_types/sqlite";
import { DOMAIN_TYPES as MYSQL_DT } from "$config/domain_types/mysql";
import { MySQLTypeMapper } from "$generator/schema/mysql/mysql_type_mapper";
import { SQLiteTypeMapper } from "$generator/schema/sqlite/sqlite_type_mapper";

import { parse_column } from "./column_parser";
import { get_domain_description } from "./domain_descriptions";
import type { Dialect, StudioColumn, StudioTable } from "./types";

export interface DomainType {
	name: string;
	sql_type: string;
	type_string: string;
	html_input: string;
	is_basic: boolean;
	description: string;
	group: string;
}

export interface DomainGroup {
	name: string;
	domains: DomainType[];
}

type DomainTypeMap = Record<string, string>;

const BASIC_TYPE_NAMES = new Set(["integer", "unsigned_integer", "bigint", "real", "numeric", "decimal", "float", "double", "varchar", "char", "binary", "blob", "longtext", "datetime", "json"]);

// Mirrors DOMAIN_GROUPS in ../static/studio.js - keep both in sync.
const DOMAIN_GROUPS: Record<string, string[]> = {
	"Keys": ["pk_id", "uuid_v7", "foreign_key"],
	"Numbers": ["integer", "unsigned_integer", "bigint", "real", "numeric", "decimal", "float", "double", "amount", "percentage"],
	"Text": ["varchar", "char", "longtext", "short_description", "long_description", "short_text", "text", "markdown", "slug", "url"],
	"Names and Identity": ["first_name", "last_name", "full_name", "username"],
	"Contact": ["email", "phone_number", "locale"],
	"Codes and Status": ["code_short", "code", "code_long", "status_enum", "currency_code", "sku", "gtin", "tax_id"],
	"Address": ["street_line_1", "street_line_2", "city", "state_province", "postal_code", "country_code", "country_name"],
	"Security and Network": ["password_hash", "ip_address"],
	"Date and Time": ["date", "datetime", "timestamp", "days", "months", "years", "hours", "minutes"],
	"Boolean": ["boolean"],
	"Files": ["binary", "blob", "image_path", "file_path"],
	"Structured Data": ["json", "json_data"],
	"Quantities": ["quantity"],
};

function group_for_domain(domain_name: string): string {
	for (const [group_name, domain_names] of Object.entries(DOMAIN_GROUPS)) {
		if (domain_names.includes(domain_name)) return group_name;
	}
	return "Application Fields";
}

// Reverse mapping: which domain types auto-append a suffix/prefix when creating columns.
// Domains NOT listed here use the domain key as the column name directly.
const DOMAIN_TO_SUFFIX: Record<string, string> = {
	image_path: "_image",
	file_path: "_file",
	timestamp: "_at",
	date: "_on",
	days: "_days",
	months: "_months",
	years: "_years",
	hours: "_hours",
	minutes: "_minutes",
};

const DOMAIN_TO_PREFIX: Record<string, string> = {
	boolean: "is_",
};

// Suffix/prefix to domain type reverse mapping for name-based resolution.
// Built from the above maps + existing config constants.
interface SuffixRule { type: "suffix"; value: string; domain: string; }
interface PrefixRule { type: "prefix"; value: string; domain: string; }
type NameRule = SuffixRule | PrefixRule;

const NAME_RULES: NameRule[] = [
	{ type: "suffix", value: "_id", domain: "foreign_key" },
	// Suffix-based domains (from config)
	...IMAGE_SUFFIXES.map((s) => ({ type: "suffix" as const, value: s.toLowerCase(), domain: "image_path" })),
	...FILE_SUFFIXES.map((s) => ({ type: "suffix" as const, value: s.toLowerCase(), domain: "file_path" })),
	{ type: "suffix", value: "_at", domain: "timestamp" },
	{ type: "suffix", value: "_on", domain: "date" },
	{ type: "suffix", value: "_by", domain: "date" },
	{ type: "suffix", value: "_days", domain: "days" },
	{ type: "suffix", value: "_months", domain: "months" },
	{ type: "suffix", value: "_years", domain: "years" },
	{ type: "suffix", value: "_hours", domain: "hours" },
	{ type: "suffix", value: "_minutes", domain: "minutes" },
	// Prefix-based domains
	...BOOLEAN_PREFIXES.map((p) => ({ type: "prefix" as const, value: p.toLowerCase(), domain: "boolean" })),
];

/** Return the canonical domain type map entries for the given dialect, with HTML input badges. */
export function get_domain_types(dialect: Dialect): DomainType[] {
	const dt_map: DomainTypeMap = dialect === "mysql"
		? (MYSQL_DT as unknown as DomainTypeMap)
		: (SQLITE_DT as unknown as DomainTypeMap);
	const mapper = dialect === "mysql" ? new MySQLTypeMapper() : new SQLiteTypeMapper();

	return Object.entries(dt_map).map(([name, sql_type]) => {
		const parsed = parse_column(`studio_domain ${sql_type}`);
		return {
			name,
			sql_type,
			type_string: parsed?.type_string ?? sql_type,
			html_input: mapper.to_html_input(sql_type),
			is_basic: BASIC_TYPE_NAMES.has(name),
			description: get_domain_description(name),
			group: group_for_domain(name),
		};
	});
}

/** Group domain types for the given dialect using the same grouping as the toolbox. */
export function get_domain_groups(dialect: Dialect): DomainGroup[] {
	const domains = get_domain_types(dialect);
	const grouped = new Map<string, DomainType[]>();
	for (const domain of domains) {
		const group_domains = grouped.get(domain.group) ?? [];
		group_domains.push(domain);
		grouped.set(domain.group, group_domains);
	}
	const order = [...Object.keys(DOMAIN_GROUPS), "Application Fields"];
	return order
		.filter((group_name) => grouped.has(group_name))
		.map((group_name) => ({ name: group_name, domains: grouped.get(group_name) as DomainType[] }));
}

/**
 * Resolve the domain type for a column from its name and SQL type.
 * Mirrors the logic in generator/schema/field_generator.ts::resolve_domain_type.
 * Returns the domain key or null if no match.
 */
export function resolve_column_domain(column_name: string, type_string: string, dialect: Dialect): string | null {
	const dt_map: DomainTypeMap = dialect === "mysql"
		? (MYSQL_DT as unknown as DomainTypeMap)
		: (SQLITE_DT as unknown as DomainTypeMap);
	const lower_name = column_name.toLowerCase();
	const conventional_names: Record<string, string> = {
		id: "pk_id",
		name: dialect === "mysql" ? "full_name" : "text",
		display: dialect === "mysql" ? "varchar" : "text",
		option_display: dialect === "mysql" ? "varchar" : "text",
		created_at: "timestamp",
		updated_at: "timestamp",
	};
	const conventional = conventional_names[lower_name];
	if (conventional) return conventional;

	// 1. Exact name match against DOMAIN_TYPES keys
	if (lower_name in dt_map) return lower_name;

	// 2. Suffix/prefix heuristics
	for (const rule of NAME_RULES) {
		if (rule.type === "suffix" && lower_name.endsWith(rule.value)) return rule.domain;
		if (rule.type === "prefix" && lower_name.startsWith(rule.value)) return rule.domain;
	}

	const basic_match = Object.keys(dt_map).find((name) => BASIC_TYPE_NAMES.has(name) && domain_type_matches(name, type_string, dialect));
	if (basic_match) return basic_match;
	return Object.keys(dt_map).find((name) => domain_type_matches(name, type_string, dialect)) ?? null;
}

export function domain_type_matches(domain_name: string, type_string: string, dialect: Dialect): boolean {
	const domain = get_domain_types(dialect).find((item) => item.name === domain_name);
	return domain !== undefined && normalize_type(domain.type_string) === normalize_type(type_string);
}

function normalize_type(type_string: string): string {
	return type_string.trim().toUpperCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",");
}

/**
 * Suggest a column name for a given domain type key.
 * If the domain has a conventional suffix (e.g. _image), return "<stem><suffix>".
 * If the domain has a prefix (e.g. is_), return "<prefix><stem>".
 * Otherwise return the domain key itself.
 */
export function suggest_column_name(domain_name: string, stem: string): string {
	const suffix = DOMAIN_TO_SUFFIX[domain_name];
	if (suffix) {
		// Avoid double suffixing: if stem already ends with it, just use stem
		if (stem.endsWith(suffix)) return stem;
		return `${stem}${suffix}`;
	}

	const prefix = DOMAIN_TO_PREFIX[domain_name];
	if (prefix) {
		if (stem.startsWith(prefix)) return stem;
		return `${prefix}${stem}`;
	}

	// Exact-match domains: use the domain key as the column name
	return domain_name;
}

function template_column(name: string, type_string: string, overrides: Partial<StudioColumn>, order: StudioColumn["modifier_order"]): StudioColumn {
	return {
		name,
		type_string,
		nullability: "unspecified",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		modifier_order: order,
		...overrides,
	};
}

/**
 * Default new-table columns:
 *   id, name, display (generated from name), created_at, updated_at
 * Sqlite follows 05-frameworks.sql, mysql follows its 05-frameworks.sql twin.
 */
export function default_table_columns(dialect: Dialect): StudioColumn[] {
	if (dialect === "mysql") {
		return [
			template_column("id", "INT UNSIGNED", { domain_type: "pk_id", nullability: "not_null", is_auto_increment: true, is_primary_key: true }, ["nullability", "auto_increment", "primary_key"]),
			template_column("name", "VARCHAR(255)", { domain_type: "full_name", nullability: "not_null", default_value: "''" }, ["nullability", "default"]),
			template_column("display", "VARCHAR(255)", { domain_type: "varchar", is_generated: true, generated_expr: "name", generated_kind: "VIRTUAL" }, ["generated"]),
			template_column("created_at", "TIMESTAMP", { domain_type: "timestamp", nullability: "not_null", default_value: "CURRENT_TIMESTAMP" }, ["nullability", "default"]),
			template_column("updated_at", "TIMESTAMP", { domain_type: "timestamp", nullability: "not_null", default_value: "CURRENT_TIMESTAMP", on_update_current_timestamp: true }, ["nullability", "default", "on_update"]),
		];
	}

	return [
		template_column("id", "INTEGER", { domain_type: "pk_id", is_primary_key: true }, ["primary_key"]),
		template_column("name", "TEXT", { domain_type: "text", default_value: "''" }, ["default"]),
		template_column("display", "TEXT", { domain_type: "text", is_generated: true, generated_expr: "name", generated_kind: "VIRTUAL" }, ["generated"]),
		template_column("created_at", "TIMESTAMP", { domain_type: "timestamp", nullability: "not_null", default_value: "CURRENT_TIMESTAMP" }, ["nullability", "default"]),
		template_column("updated_at", "TIMESTAMP", { domain_type: "timestamp", default_value: "CURRENT_TIMESTAMP" }, ["default"]),
	];
}

export function make_default_table(name: string, dialect: Dialect): StudioTable {
	return { name, columns: default_table_columns(dialect), table_foreign_keys: [], table_suffix_raw: "" };
}
