/**
 * Canonical Domain Types - SQLite SQL Mapping (Refined)
 *
 * Per-dialect SQL mapping for SQLite. Types that diverge from
 * MySQL (pk_id, uuid_v7, currency_amount, percentage_rate, boolean) use
 * native SQLite affinities. The rest use MySQL-compatible SQL definitions.
 *
 * See also: config/domain_types/mysql.ts
 *           CONTEXT.md § Domain Types
 */

export const DOMAIN_TYPES = {
	// --- Primary Keys & Identifiers ---
	// INTEGER PRIMARY KEY auto-aliases to SQLite native 64-bit rowid
	pk_id: "INTEGER PRIMARY KEY",
	// BLOB is the optimal SQLite affinity for 16-byte binary UUIDv7
	uuid_v7: "BLOB",
	// FK columns: type matches the referenced PK (typically INTEGER in SQLite)
	foreign_key: "INTEGER",

	// --- Basic SQL Types ---
	integer: "INTEGER",
	unsigned_integer: "INTEGER",
	bigint: "INTEGER",
	real: "REAL",
	numeric: "NUMERIC",
	decimal: "DECIMAL(18, 2)",
	float: "REAL",
	double: "REAL",
	varchar: "VARCHAR(255)",
	char: "CHAR(1)",
	binary: "BLOB",
	blob: "BLOB",
	longtext: "TEXT",
	date: "DATE",
	datetime: "DATETIME",
	json: "JSON",

	// --- Names & User Profiles ---
	first_name: "VARCHAR(100)",
	last_name: "VARCHAR(100)",
	full_name: "VARCHAR(255)",
	username: "VARCHAR(50)", // Expanded to support email handles

	// --- Text & Content ---
	short_description: "VARCHAR(255)", // Upgraded from 100
	long_description: "TEXT", // Upgraded from VARCHAR(255)
	short_text: "VARCHAR(255)",
	text: "TEXT",
	text_block: "TEXT",
	markdown: "MARKDOWN",

	// --- Monetary & Financial ---
	amount: "DECIMAL(18, 2)",
	currency_code: "VARCHAR(3)", // ISO 4217 (e.g., "USD", "EUR")
	percentage: "DECIMAL(7,4)",

	// --- Temporal (ISO-8601 UTC) ---
	date_only: "TEXT", // ISO-8601 "YYYY-MM-DD"
	timestamp: "TIMESTAMP", // ISO-8601 "YYYY-MM-DD HH:MM:SS.SSSZ"

	// --- Duration & Time Units ---
	days: "INTEGER",
	months: "INTEGER",
	years: "INTEGER",
	hours: "INTEGER",
	minutes: "INTEGER",

	// --- Boolean & State ---
	boolean: "INTEGER", // SQLite standard: 0 (false) / 1 (true)

	// --- Contact Information ---
	email: "VARCHAR(255)",
	phone_number: "VARCHAR(30)", // E.164 international standard

	// --- Codes, Enums & Statuses ---
	code_short: "VARCHAR(5)",
	code_medium: "VARCHAR(20)",
	code_long: "VARCHAR(64)",
	status_enum: "VARCHAR(30)", // State machine status names

	// --- Addresses ---
	street_line_1: "VARCHAR(150)", // Renamed from 'street', expanded from 50
	street_line_2: "VARCHAR(100)", // Renamed from 'street_extra', expanded from 30
	city: "VARCHAR(100)", // Expanded from 30
	state_province: "VARCHAR(100)", // Added missing regional subdivision
	postal_code: "VARCHAR(20)", // Expanded from 10
	country_code: "VARCHAR(3)", // ISO 3166-1 alpha-2 / alpha-3
	country_name: "VARCHAR(100)", // Full display country name

	// --- Security & System ---
	password_hash: "VARCHAR(255)", // Argon2id / PHC formatted string
	ip_address: "VARCHAR(45)", // IPv6 / IPv4 string representation
	json_data: "TEXT", // Serialized JSON objects

	// --- Asset Paths & Media ---
	image_path: "VARCHAR(512)", // Renamed from 'image', expanded from 255
	file_path: "VARCHAR(512)", // Renamed from 'file', expanded from 255
} as const;

// Union of all canonical domain type names (shared across dialects)
export type DomainType = keyof typeof DOMAIN_TYPES;
