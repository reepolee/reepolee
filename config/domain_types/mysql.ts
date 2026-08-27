/**
 * Canonical Domain Types - MySQL/MariaDB SQL Mapping (Refined)
 *
 * Per-dialect SQL mapping for MySQL. Mirrors the structure of the
 * SQLite DOMAIN_TYPES in config/domain_types/sqlite.ts, using
 * MySQL-appropriate types (e.g. DATE vs TEXT, TINYINT(1) vs INTEGER).
 *
 * See also: config/domain_types/sqlite.ts
 *           config/db_structure.ts
 */

export const DOMAIN_TYPES = {
	// --- Primary Keys & Identifiers ---
	// INT UNSIGNED AUTO_INCREMENT is the standard MySQL auto-increment PK
	pk_id: "INT UNSIGNED AUTO_INCREMENT",
	// BINARY(16) is the optimal MySQL type for 16-byte binary UUIDv7
	uuid_v7: "BINARY(16)",
	// FK columns: type matches the referenced PK (typically INT UNSIGNED in MySQL)
	foreign_key: "INT UNSIGNED",

	// --- Basic SQL Types ---
	integer: "INT",
	unsigned_integer: "INT UNSIGNED",
	bigint: "BIGINT",
	real: "DOUBLE",
	numeric: "DECIMAL(18,6)",
	decimal: "DECIMAL(10, 2)",
	float: "FLOAT",
	double: "DOUBLE",
	varchar: "VARCHAR(255)",
	char: "CHAR(1)",
	binary: "BINARY(16)",
	blob: "BLOB",
	longtext: "LONGTEXT",
	datetime: "DATETIME",
	json: "JSON",

	// --- Names & User Profiles ---
	first_name: "VARCHAR(100)",
	last_name: "VARCHAR(100)",
	full_name: "VARCHAR(255)",
	username: "VARCHAR(50)",

	// --- Text & Content ---
	short_description: "VARCHAR(255)",
	long_description: "TEXT",
	short_text: "VARCHAR(255)",
	text: "TEXT",
	markdown: "TEXT COMMENT 'MARKDOWN'",
	slug: "VARCHAR(255)", // URL-safe identifier
	url: "VARCHAR(2048)", // External/website link

	// --- Monetary & Financial ---
	// Store money in minor units / cents (BIGINT) to prevent floating-point errors
	amount: "DECIMAL(18,2)",
	currency_code: "CHAR(3)", // ISO 4217 (e.g., "USD", "EUR")
	percentage: "DECIMAL(7,4)", // Stored as decimal ratio (e.g., 0.1550 = 15.5%)

	// --- Temporal (ISO-8601 UTC) ---
	date: "DATE",
	timestamp: "TIMESTAMP",

	// --- Duration & Time Units ---
	days: "INTEGER",
	months: "INTEGER",
	years: "INTEGER",
	hours: "INTEGER",
	minutes: "INTEGER",

	// --- Quantities ---
	quantity: "DECIMAL(12,3)", // Order/inventory quantity, e.g. "2 pcs" or "0.5 liter"

	// --- Boolean & State ---
	boolean: "TINYINT(1)", // MySQL standard: 0 (false) / 1 (true)

	// --- Contact Information ---
	email: "VARCHAR(255)",
	phone_number: "VARCHAR(30)", // E.164 international standard
	locale: "VARCHAR(10)", // BCP-47 language tag (e.g. "en-US")

	// --- Codes, Enums & Statuses ---
	code_short: "VARCHAR(5)",
	code: "VARCHAR(20)",
	code_long: "VARCHAR(64)",
	status_enum: "VARCHAR(30)", // State machine status names
	sku: "VARCHAR(64)", // Product/inventory stock-keeping unit
	gtin: "VARCHAR(14)", // Global Trade Item Number (EAN-8/13, UPC-A, GTIN-14)
	tax_id: "VARCHAR(30)", // VAT/company tax identifier (format varies by country)

	// --- Addresses ---
	street_line_1: "VARCHAR(150)",
	street_line_2: "VARCHAR(100)",
	city: "VARCHAR(100)",
	state_province: "VARCHAR(100)", // Regional subdivision
	postal_code: "VARCHAR(20)",
	country_code: "CHAR(3)", // ISO 3166-1 alpha-2 / alpha-3
	country_name: "VARCHAR(100)", // Full display country name

	// --- Security & System ---
	password_hash: "VARCHAR(255)", // Argon2id / PHC formatted string
	ip_address: "VARCHAR(45)", // IPv6 / IPv4 string representation
	json_data: "JSON", // Native MySQL JSON column

	// --- Asset Paths & Media ---
	image_path: "VARCHAR(512)", // Browsable image path
	file_path: "VARCHAR(512)", // Browsable document path
} as const;

// Union of all canonical domain type names (shared across dialects)
export type DomainType = keyof typeof DOMAIN_TYPES;
