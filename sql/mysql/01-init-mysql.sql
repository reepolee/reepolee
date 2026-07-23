DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
    session_code VARCHAR(50) NOT NULL PRIMARY KEY COMMENT 'ICU',
    session_json TEXT        NOT NULL COMMENT 'ICU'
) COMMENT '';

DROP TABLE IF EXISTS rate_limit_counters;

CREATE TABLE rate_limit_counters (
    counter_key VARCHAR(191)   NOT NULL PRIMARY KEY COMMENT 'ICU',
    count       INT UNSIGNED   NOT NULL DEFAULT 0 COMMENT 'ICU',
    expires_at  BIGINT         NOT NULL COMMENT 'ICU',
    INDEX rate_limit_counters_expires_at (expires_at)
) COMMENT '';

DROP TABLE IF EXISTS modules;

CREATE TABLE modules (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    code        VARCHAR(15)  NOT NULL DEFAULT 'default' COMMENT 'ICU',
    name        VARCHAR(30)  NOT NULL DEFAULT 'default' COMMENT 'ICU',
    description VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'ICU',
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '';

CREATE UNIQUE INDEX modules_code_unique ON modules(code);

INSERT IGNORE INTO modules (code, name) VALUES
('default','Default'),
('user','User'),
('system','System Administration'),
('admin','Administration'),
('examples','Examples');

DROP TABLE IF EXISTS images;

CREATE TABLE images (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    folder            VARCHAR(255) NULL DEFAULT '/' COMMENT 'ICU',
    filename          VARCHAR(255) NOT NULL COMMENT 'ICU',
    s3_key            VARCHAR(512) NOT NULL COMMENT '',
    original_filename VARCHAR(255) NULL DEFAULT '' COMMENT 'ICU',
    title             VARCHAR(255) NULL DEFAULT '' COMMENT '',
    description       TEXT         NULL DEFAULT '' COMMENT '',
    tags              VARCHAR(500) NULL DEFAULT '' COMMENT 'ICU',
    mime_type         VARCHAR(127) NULL DEFAULT 'image/webp' COMMENT '',
    width             INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    height            INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    file_size         INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    created_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_images_folder_filename(folder, filename)
) COMMENT '';

DROP TABLE IF EXISTS files;

CREATE TABLE files (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    folder            VARCHAR(255) NULL DEFAULT '/' COMMENT 'ICU',
    filename          VARCHAR(255) NOT NULL COMMENT 'ICU',
    s3_key            VARCHAR(512) NOT NULL COMMENT '',
    original_filename VARCHAR(255) NULL DEFAULT '' COMMENT 'ICU',
    title             VARCHAR(255) NULL DEFAULT '' COMMENT '',
    description       TEXT         NULL DEFAULT '' COMMENT '',
    tags              VARCHAR(500) NULL DEFAULT '' COMMENT 'ICU',
    mime_type         VARCHAR(127) NULL DEFAULT 'application/octet-stream' COMMENT '',
    file_type         VARCHAR(10)  NULL DEFAULT '' COMMENT 'ICUF',
    file_size         INT UNSIGNED NULL DEFAULT 0 COMMENT '',
    created_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_files_folder_filename(folder, filename)
) COMMENT '';

DROP VIEW IF EXISTS v_table_counts;

CREATE VIEW v_table_counts AS
SELECT
    'images',
    '/system/images',
    COUNT(*)
FROM images UNION ALL SELECT 'files', '/system/files', COUNT(*) FROM files UNION ALL SELECT 'modules', NULL, COUNT(*) FROM modules UNION ALL SELECT 'users', '/system/users', COUNT(*) FROM users;

DROP VIEW IF EXISTS v_files;

CREATE VIEW v_files AS
SELECT
    id,
    folder,
    filename,
    s3_key,
    original_filename,
    title,
    description,
    tags,
    mime_type,
    file_type,
    file_size,
    created_at,
    updated_at,
    CONCAT_WS('__', folder, filename, s3_key, IFNULL(original_filename, ''), IFNULL(title, ''), IFNULL(description, ''), IFNULL(tags, ''), mime_type) AS search_text
FROM files;

DROP VIEW IF EXISTS v_images;

CREATE VIEW v_images AS
SELECT
    id,
    folder,
    filename,
    s3_key,
    original_filename,
    title,
    description,
    tags,
    mime_type,
    width,
    height,
    file_size,
    created_at,
    updated_at,
    CONCAT_WS('__', folder, filename, s3_key, IFNULL(original_filename, ''), IFNULL(title, ''), IFNULL(description, ''), IFNULL(tags, ''), mime_type) AS search_text
FROM images;

DROP TABLE IF EXISTS global_scopes;

CREATE TABLE global_scopes (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    module_code  VARCHAR(15)  NOT NULL DEFAULT '' COMMENT 'ICU',
    feature_name VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ICU',
    table_name   VARCHAR(64)  NOT NULL COMMENT 'ICU',
    scope_key    VARCHAR(64)  NOT NULL COMMENT 'ICU',
    display_name VARCHAR(100) NOT NULL DEFAULT '' COMMENT '',
    where_clause TEXT         NOT NULL COMMENT '',
    sort_order   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '',
    is_default   TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '',
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_global_scopes_module_table_key(module_code, feature_name, table_name, scope_key)
) COMMENT '';

DROP TABLE IF EXISTS translations;

CREATE TABLE translations (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    lang        VARCHAR(10)  NOT NULL COMMENT 'ICU',
    namespace   VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'ICU',
    key_path    VARCHAR(255) NOT NULL COMMENT 'ICU',
    translation TEXT         NOT NULL DEFAULT '' COMMENT 'ICU',
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_translations(lang, namespace, key_path)
) COMMENT '';

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
    created_at               TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at               TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP()
) COMMENT '';

-- email is not unique - username is the primary identifier
CREATE UNIQUE INDEX users_username_unique ON users(username);

CREATE INDEX users_email ON users(email);
