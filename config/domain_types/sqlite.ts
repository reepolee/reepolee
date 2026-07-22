/**
 * Canonical Domain Types - SQLite SQL mapping
 *
 * Per-dialect SQL mapping for SQLite. Types that diverge from
 * MySQL (pk_id, uuid_v7, currency, percent, boolean) use
 * honest SQLite-native types. The rest use the same VARCHAR(N)
 * SQL as MySQL for portability (SQLite accepts it silently).
 *
 * See also:	config/domain_types/mysql.ts
 * 				CONTEXT.md   § Domain Types
 */

export const DOMAIN_TYPES = {
	// PK & ID
	// INTEGER PRIMARY KEY is SQLite's auto-increment rowid alias
	pk_id: "INTEGER PRIMARY KEY",
	// BLOB is the correct SQLite affinity for binary UUID storage
	uuid_v7: "BLOB",

	// Names
	// VARCHAR(N) accepted by SQLite (stored as TEXT, N ignored)
	first_name: "VARCHAR(100)",
	last_name: "VARCHAR(100)",
	full_name: "VARCHAR(255)",

	// Text & Descriptions
	short_description: "VARCHAR(100)",
	long_description: "VARCHAR(255)",
	text_block: "TEXT",

	// Monetary & Percent
	// SQLite has no real DECIMAL type - NUMERIC affinity is closest
	currency: "NUMERIC",
	percent: "NUMERIC",

	// Temporal
	date_only: "DATE",
	timestamp: "TIMESTAMP",

	// Boolean
	// SQLite stores booleans as INTEGER (0/1)
	boolean: "INTEGER",

	// Contact
	email: "VARCHAR(255)",
	phone: "VARCHAR(50)",

	// Code / Identifier
	code_short: "VARCHAR(3)",
	code_medium: "VARCHAR(10)",
	code_long: "VARCHAR(64)",

	// Address
	street: "VARCHAR(50)",
	street_extra: "VARCHAR(30)",
	postal_code: "VARCHAR(10)",
	city: "VARCHAR(30)",
	country: "VARCHAR(3)",

	// System / Meta
	username: "VARCHAR(20)",
	password_hash: "VARCHAR(255)",
	search_text: "TEXT",

	// Media
	// Stores a browsable path (e.g. "/images/teams/members/xyz.webp"), not the binary itself
	image: "VARCHAR(255)",
} as const;

// Union of all canonical domain type names (shared across dialects).
export type DomainType = keyof typeof DOMAIN_TYPES;
