/**
 *
 * Canonical Domain Types - MySQL/MariaDB SQL mapping
 *
 * Single source of truth for the canonical column type taxonomy.
 * These are the agreed SQL types for all new tables and columns.
 * See CONTEXT.md § Domain Types for descriptions and migration gaps.
 *
 * VARCHAR widths below cover the canonical domain taxonomy (names,
 * codes, contact, address). Tables may use wider VARCHAR(N) per
 * specific needs - these are the recommended bucket defaults.
 *
 */
import { CURRENCY_FIELD, PERCENT_FIELD } from "$config/db_structure";

export const DOMAIN_TYPES = {
	// PK & ID
	pk_id: "INT UNSIGNED AUTO_INCREMENT",
	uuid_v7: "BINARY(16)",

	// Names
	first_name: "VARCHAR(100)",
	last_name: "VARCHAR(100)",
	full_name: "VARCHAR(255)",

	// Text & Descriptions
	short_description: "VARCHAR(100)",
	long_description: "VARCHAR(255)",
	text_block: "TEXT",

	// Monetary & Percent
	currency: CURRENCY_FIELD,
	percent: PERCENT_FIELD,

	// Temporal
	date_only: "DATE",
	timestamp: "TIMESTAMP",

	// Boolean
	boolean: "TINYINT(1)",

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

	// Documents
	// Stores a browsable path (e.g. "/files/contracts/xyz.pdf"), not the binary itself
	file: "VARCHAR(255)",
} as const;

// Union of all canonical domain type names.
export type DomainType = keyof typeof DOMAIN_TYPES;
