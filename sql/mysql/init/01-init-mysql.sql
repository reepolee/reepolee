-- SUGGESTED INI
--
-- [mysqld]
-- # Native Thread Pooling (essential for light VPS nodes handling high connection bursts)
-- thread_handling = pool-of-threads
-- thread_pool_size = 4                 # Set equal to your VPS CPU core count
--
-- # InnoDB Tuning (scale buffer pool according to available VPS RAM)
-- innodb_buffer_pool_size = 1G         # Allocate ~50-60% of total available RAM
-- innodb_log_file_size = 256M
-- innodb_flush_log_at_trx_commit = 2   # High-throughput write performance for backoffices
--
-- # Encoding & Standards
-- character_set_server = utf8mb4
-- collation_server = utf8mb4_unicode_ci
-- sql_mode = "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION"
--
DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
    session_code VARCHAR(50) NOT NULL PRIMARY KEY COMMENT 'ICU',
    session_json TEXT        NOT NULL COMMENT 'ICU',
    display      VARCHAR(50) GENERATED ALWAYS AS(session_code) VIRTUAL
) COMMENT '';

DROP TABLE IF EXISTS rate_limit_counters;

CREATE TABLE rate_limit_counters (
    counter_key VARCHAR(191) NOT NULL PRIMARY KEY COMMENT 'ICU',
    count       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ICU',
    expires_at  BIGINT       NOT NULL COMMENT 'ICU',
    display     VARCHAR(191) GENERATED ALWAYS AS(counter_key) VIRTUAL,
    INDEX rate_limit_counters_expires_at(expires_at)
) COMMENT '';

DROP TABLE IF EXISTS modules;

CREATE TABLE modules (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    code                VARCHAR(15)  NOT NULL DEFAULT 'default' COMMENT 'ICU',
    name                VARCHAR(30)  NOT NULL DEFAULT 'default' COMMENT 'ICU',
    description         VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'ICU',
    display             VARCHAR(30)  GENERATED ALWAYS AS(name) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT UNSIGNED NULL DEFAULT NULL
) COMMENT '';

CREATE UNIQUE INDEX modules_code_unique ON modules(code);

CREATE INDEX modules_archived_at ON modules(archived_at);

INSERT IGNORE INTO modules (code, name) VALUES
('default','Default'),
('user','User'),
('system','System Administration'),
('admin','Administration'),
('examples','Examples');

DROP TABLE IF EXISTS db_tables;

-- Metadata snapshot of the DB's own tables, repopulated from the DDL cache on
-- each /reeman/tables load. Read-only from the CRUD's perspective - rows are
-- never created/edited by hand, only refreshed wholesale.
CREATE TABLE db_tables (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    name         VARCHAR(64)  NOT NULL COMMENT 'ICU',
    column_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ICU',
    fk_count     INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ICU',
    has_crud     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'ICU',
    display      VARCHAR(64)  GENERATED ALWAYS AS(name) VIRTUAL,
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '';

CREATE UNIQUE INDEX db_tables_name_unique ON db_tables(name);

DROP TABLE IF EXISTS db_routes;

-- Metadata snapshot of generated routes, repopulated from routes.ts + schema
-- folders on each /reeman/routes load. Read-only from the CRUD's perspective -
-- rows are never created/edited by hand, only refreshed wholesale.
CREATE TABLE db_routes (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    url        VARCHAR(255) NOT NULL COMMENT 'ICU',
    table_name VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ICU',
    module     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ICU',
    removable  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'ICU',
    display    VARCHAR(255) GENERATED ALWAYS AS(url) VIRTUAL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '';

CREATE UNIQUE INDEX db_routes_url_unique ON db_routes(url);

DROP TABLE IF EXISTS images;

CREATE TABLE images (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    folder              VARCHAR(255) NULL DEFAULT '/' COMMENT 'ICU',
    filename            VARCHAR(255) NOT NULL COMMENT 'ICU',
    s3_key              VARCHAR(512) NOT NULL COMMENT '',
    original_filename   VARCHAR(255) NULL DEFAULT '' COMMENT 'ICU',
    title               VARCHAR(255) NULL DEFAULT '' COMMENT '',
    description         TEXT         NULL DEFAULT '' COMMENT '',
    tags                VARCHAR(500) NULL DEFAULT '' COMMENT 'ICU',
    mime_type           VARCHAR(127) NULL DEFAULT 'image/webp' COMMENT '',
    width               INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    height              INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    file_size           INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    display             VARCHAR(255) GENERATED ALWAYS AS(COALESCE(NULLIF(title, ''), NULLIF(original_filename, ''), filename)) VIRTUAL,
    created_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT UNSIGNED NULL DEFAULT NULL,
    UNIQUE KEY uk_images_folder_filename(folder, filename)
) COMMENT '';

CREATE INDEX images_archived_at ON images(archived_at);

DROP TABLE IF EXISTS files;

CREATE TABLE files (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    folder              VARCHAR(255) NULL DEFAULT '/' COMMENT 'ICU',
    filename            VARCHAR(255) NOT NULL COMMENT 'ICU',
    s3_key              VARCHAR(512) NOT NULL COMMENT '',
    original_filename   VARCHAR(255) NULL DEFAULT '' COMMENT 'ICU',
    title               VARCHAR(255) NULL DEFAULT '' COMMENT '',
    description         TEXT         NULL DEFAULT '' COMMENT '',
    tags                VARCHAR(500) NULL DEFAULT '' COMMENT 'ICU',
    mime_type           VARCHAR(127) NULL DEFAULT 'application/octet-stream' COMMENT '',
    file_type           VARCHAR(10)  NULL DEFAULT '' COMMENT 'ICUF',
    file_size           INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    -- Soft FK to users.id by naming convention only (no REFERENCES constraint).
-- Set on every upload from the authenticated session (M4 of
-- PLAN_image_file_manager_extraction.md); scopes a user-facing route to
-- 'my files only' via a global_scopes row (uploaded_by_user_id = ::session.user.id).
uploaded_by_user_id INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ICU',
    display             VARCHAR(255) GENERATED ALWAYS AS(COALESCE(NULLIF(title, ''), NULLIF(original_filename, ''), filename)) VIRTUAL,
    created_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT UNSIGNED NULL DEFAULT NULL,
    UNIQUE KEY uk_files_folder_filename(folder, filename)
) COMMENT '';

CREATE INDEX files_archived_at ON files(archived_at);

DROP VIEW IF EXISTS v_table_counts;

CREATE VIEW v_table_counts AS
SELECT
    'images'         AS display,
    'images'         AS table_name,
    '/system/images' AS route,
    COUNT(*) AS record_count
FROM images
WHERE archived_at IS NULL
UNION ALL SELECT 'files', 'files', '/system/files', COUNT(*) FROM files
WHERE archived_at IS NULL
UNION ALL SELECT 'modules', 'modules', NULL, COUNT(*) FROM modules
WHERE archived_at IS NULL
UNION ALL SELECT 'users', 'users', '/system/users', COUNT(*) FROM users
WHERE archived_at IS NULL;

DROP VIEW IF EXISTS v_files;

CREATE VIEW v_files AS
SELECT
    f.id,
    f.display,
    f.folder,
    f.filename,
    f.s3_key,
    f.original_filename,
    f.title,
    f.description,
    f.tags,
    f.mime_type,
    f.file_type,
    f.file_size,
    f.uploaded_by_user_id,
    f.archived_at,
    f.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    f.created_at,
    f.updated_at,
    CONCAT_WS('__', f.folder, f.filename, f.s3_key, IFNULL(f.original_filename, ''), IFNULL(f.title, ''), IFNULL(f.description, ''), IFNULL(f.tags, ''), f.mime_type) AS search_text
FROM files f
    LEFT JOIN users u
        ON u.id = f.archived_by_user_id;

DROP VIEW IF EXISTS v_images;

CREATE VIEW v_images AS
SELECT
    i.id,
    i.display,
    i.folder,
    i.filename,
    i.s3_key,
    i.original_filename,
    i.title,
    i.description,
    i.tags,
    i.mime_type,
    i.width,
    i.height,
    i.file_size,
    i.archived_at,
    i.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    i.created_at,
    i.updated_at,
    CONCAT_WS('__', i.folder, i.filename, i.s3_key, IFNULL(i.original_filename, ''), IFNULL(i.title, ''), IFNULL(i.description, ''), IFNULL(i.tags, ''), i.mime_type) AS search_text
FROM images i
    LEFT JOIN users u
        ON u.id = i.archived_by_user_id;

DROP TABLE IF EXISTS global_scopes;

CREATE TABLE global_scopes (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    module_code         VARCHAR(15)  NOT NULL DEFAULT '' COMMENT 'ICU',
    feature_name        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ICU',
    table_name          VARCHAR(64)  NOT NULL COMMENT 'ICU',
    scope_key           VARCHAR(64)  NOT NULL COMMENT 'ICU',
    display_name        VARCHAR(100) NOT NULL DEFAULT '' COMMENT '',
    where_clause        TEXT         NOT NULL COMMENT '',
    sort_order          INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '',
    is_default          TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '',
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT_WS(':', module_code, feature_name, table_name, scope_key)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    NULL ON UPDATE CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT UNSIGNED NULL DEFAULT NULL,
    UNIQUE KEY uk_global_scopes_module_table_key(module_code, feature_name, table_name, scope_key)
) COMMENT '';

CREATE INDEX global_scopes_archived_at ON global_scopes(archived_at);

-- 'My files' ownership scope (M4 of PLAN_image_file_manager_extraction.md):
-- scopes a user-facing route over the files table to rows the current user
-- uploaded. Populated on every upload via uploaded_by_user_id. Reeman admin
-- routes never resolve scopes (they pass an empty scope_clause), so this does
-- not affect the sysadmin files UI.
INSERT IGNORE INTO global_scopes (module_code, feature_name, table_name, scope_key, display_name, where_clause, sort_order, is_default) VALUES
('user','','files','my_files','My files','uploaded_by_user_id = ::session.user.id',0,1);

DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id                       INT          NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    username                 VARCHAR(255) NOT NULL COMMENT 'ICU',
    email                    VARCHAR(255) NOT NULL COMMENT 'ICU',
    name                     VARCHAR(80)  DEFAULT '' NULL COMMENT 'ICU',
    nickname                 VARCHAR(20)  DEFAULT '' NULL COMMENT 'ICU',
    avatar_filename          VARCHAR(255) DEFAULT '' NULL COMMENT '',
    verified_at              TIMESTAMP    NULL DEFAULT NULL,
    hashed_password          VARCHAR(255) DEFAULT NULL COMMENT '',
    invitation_code          VARCHAR(64)  DEFAULT '' NULL COMMENT '',
    modules_tags             VARCHAR(255) DEFAULT 'user' NULL COMMENT '',
    previous_hashed_password VARCHAR(255) DEFAULT NULL COMMENT '',
    display                  VARCHAR(255) GENERATED ALWAYS AS(COALESCE(NULLIF(name, ''), username)) VIRTUAL,
    created_at               TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at               TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP(),
    archived_at              TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id      INT UNSIGNED NULL DEFAULT NULL
) COMMENT '';

-- email is not unique - username is the primary identifier
CREATE UNIQUE INDEX users_username_unique ON users(username);

CREATE INDEX users_email ON users(email);
CREATE INDEX users_archived_at ON users(archived_at);
