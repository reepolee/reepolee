/**
 * Reeman meta tables (db_tables, db_routes).
 *
 * These are NOT user schema - they are metadata snapshots that back the
 * standard CRUD pages /tables and /routes. db_tables holds the
 * DB's own tables (repopulated from the DDL cache on each index load via
 * refresh_db_tables()) and db_routes holds the generated routes (repopulated
 * via refresh_db_routes()). Rows are never hand-edited, only refreshed
 * wholesale, so creating the tables when missing is safe.
 *
 * ensure_reeman_meta_tables() is called on every reeman server start so a DB
 * initialized before these tables existed (or a fresh install that skips the
 * schema init) self-heals. DDL mirrors sql/sqlite/init/01-init-sqlite.sql and
 * sql/mysql/init/01-init-mysql.sql - keep both in sync when the schema changes.
 */

import { db } from "$config/db";
import { db_type } from "$lib/resolve_db_type";

const DDL_SQLITE: string[] = [
	`CREATE TABLE IF NOT EXISTS db_tables (
		id           INTEGER   PRIMARY KEY,
		name         TEXT      NOT NULL,
		column_count INTEGER   NOT NULL DEFAULT 0,
		fk_count     INTEGER   NOT NULL DEFAULT 0,
		has_crud     INTEGER   NOT NULL DEFAULT 0,
		display      TEXT      GENERATED ALWAYS AS(name) VIRTUAL,
		created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS db_tables_name_unique ON db_tables(name)`,
	`CREATE TRIGGER IF NOT EXISTS db_tables_updated_at_trigger AFTER UPDATE ON db_tables FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
		UPDATE db_tables
		SET
			updated_at = CURRENT_TIMESTAMP
		WHERE id = NEW.id;
	END`,
	`CREATE TABLE IF NOT EXISTS db_routes (
		id          INTEGER   PRIMARY KEY,
		url         TEXT      NOT NULL,
		table_name  TEXT      NOT NULL DEFAULT '',
		module      TEXT      NOT NULL DEFAULT '',
		removable   INTEGER   NOT NULL DEFAULT 0,
		display     TEXT      GENERATED ALWAYS AS(url) VIRTUAL,
		created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS db_routes_url_unique ON db_routes(url)`,
	`CREATE TRIGGER IF NOT EXISTS db_routes_updated_at_trigger AFTER UPDATE ON db_routes FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
		UPDATE db_routes
		SET
			updated_at = CURRENT_TIMESTAMP
		WHERE id = NEW.id;
	END`,
];

// MySQL: no CREATE ... IF NOT EXISTS for indexes/triggers, so the unique keys
// are declared inline. updated_at uses ON UPDATE CURRENT_TIMESTAMP instead of
// triggers (mirrors sql/mysql/init/01-init-mysql.sql).
const DDL_MYSQL: string[] = [
	`CREATE TABLE IF NOT EXISTS db_tables (
		id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
		name         VARCHAR(64)  NOT NULL COMMENT 'ICU',
		column_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ICU',
		fk_count     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ICU',
		has_crud     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'ICU',
		display      VARCHAR(64)  GENERATED ALWAYS AS (name) VIRTUAL,
		created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		UNIQUE KEY db_tables_name_unique (name)
	)`,
	`CREATE TABLE IF NOT EXISTS db_routes (
		id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
		url        VARCHAR(255) NOT NULL COMMENT 'ICU',
		table_name VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ICU',
		module     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ICU',
		removable  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'ICU',
		display    VARCHAR(255) GENERATED ALWAYS AS (url) VIRTUAL,
		created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		UNIQUE KEY db_routes_url_unique (url)
	)`,
];

/**
 * Create the reeman meta tables if they do not exist yet. Idempotent - safe to
 * call on every start (and to re-run).
 */
export async function ensure_reeman_meta_tables(): Promise<void> {
	const statements = db_type === "mysql" ? DDL_MYSQL : DDL_SQLITE;
	for (const sql of statements) {
		await db.unsafe(sql);
	}
}
