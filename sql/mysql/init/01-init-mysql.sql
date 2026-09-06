DROP TABLE IF EXISTS files;

CREATE TABLE IF NOT EXISTS files (
    id                  INT(10)      NOT NULL AUTO_INCREMENT COMMENT 'ICU',
    folder              VARCHAR(255) DEFAULT '/' COMMENT 'ICU',
    filename            VARCHAR(255) NOT NULL COMMENT 'ICU',
    s3_key              VARCHAR(512) NOT NULL,
    original_filename   VARCHAR(255) DEFAULT '' COMMENT 'ICU',
    title               VARCHAR(255) DEFAULT '',
    description         TEXT         DEFAULT '',
    tags                VARCHAR(500) DEFAULT '' COMMENT 'ICU',
    mime_type           VARCHAR(127) DEFAULT 'application/octet-stream',
    file_type           VARCHAR(10)  DEFAULT '' COMMENT 'ICUF',
    file_size           INT(10)      DEFAULT 0,
    uploaded_by_user_id INT(10)      NOT NULL DEFAULT 0 COMMENT 'ICU',
    display             VARCHAR(255) GENERATED ALWAYS AS(COALESCE(NULLIF(title, ''), NULLIF(original_filename, ''), filename)) VIRTUAL,
    created_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT(10)      DEFAULT NULL,
    PRIMARY KEY(id),
    UNIQUE KEY uk_files_folder_filename(folder, filename),
    KEY files_archived_at(archived_at)
);

DROP TABLE IF EXISTS global_scopes;

CREATE TABLE IF NOT EXISTS global_scopes (
    id                  INT(10)      NOT NULL AUTO_INCREMENT COMMENT 'ICU',
    module_code         VARCHAR(15)  NOT NULL DEFAULT '' COMMENT 'ICU',
    feature_name        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ICU',
    table_name          VARCHAR(64)  NOT NULL COMMENT 'ICU',
    scope_key           VARCHAR(64)  NOT NULL COMMENT 'ICU',
    display_name        VARCHAR(100) NOT NULL DEFAULT '',
    where_clause        TEXT         NOT NULL,
    sort_order          INT(10)      NOT NULL DEFAULT 0,
    is_default          TINYINT(1)   NOT NULL DEFAULT 0,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT_WS('::', module_code, feature_name, table_name, scope_key)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at          TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP(),
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT(10)      DEFAULT NULL,
    PRIMARY KEY(id),
    UNIQUE KEY uk_global_scopes_module_table_key(module_code, feature_name, table_name, scope_key),
    KEY global_scopes_archived_at(archived_at)
);

DROP TABLE IF EXISTS images;

CREATE TABLE IF NOT EXISTS images (
    id                  INT(10)      NOT NULL AUTO_INCREMENT COMMENT 'ICU',
    folder              VARCHAR(255) DEFAULT '/' COMMENT 'ICU',
    filename            VARCHAR(255) NOT NULL COMMENT 'ICU',
    s3_key              VARCHAR(512) NOT NULL,
    original_filename   VARCHAR(255) DEFAULT '' COMMENT 'ICU',
    title               VARCHAR(255) DEFAULT '',
    description         TEXT         DEFAULT '',
    tags                VARCHAR(500) DEFAULT '' COMMENT 'ICU',
    mime_type           VARCHAR(127) DEFAULT 'image/webp',
    width               INT(10)      DEFAULT 0,
    height              INT(10)      DEFAULT 0,
    file_size           INT(10)      DEFAULT 0,
    display             VARCHAR(255) GENERATED ALWAYS AS(COALESCE(NULLIF(title, ''), NULLIF(original_filename, ''), filename)) VIRTUAL,
    created_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at          TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT(10)      DEFAULT NULL,
    PRIMARY KEY(id),
    UNIQUE KEY uk_images_folder_filename(folder, filename),
    KEY images_archived_at(archived_at)
);

DROP TABLE IF EXISTS modules;

CREATE TABLE IF NOT EXISTS modules (
    id                  INT(10)      NOT NULL AUTO_INCREMENT COMMENT 'ICU',
    code                VARCHAR(15)  NOT NULL DEFAULT 'default' COMMENT 'ICU',
    name                VARCHAR(30)  NOT NULL DEFAULT 'default' COMMENT 'ICU',
    description         VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'ICU',
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT(10)      DEFAULT NULL,
    PRIMARY KEY(id),
    UNIQUE KEY modules_code_unique(code),
    KEY modules_archived_at(archived_at)
);

DROP TABLE IF EXISTS rate_limit_counters;

CREATE TABLE IF NOT EXISTS rate_limit_counters (
    counter_key VARCHAR(191) NOT NULL COMMENT 'ICU',
    count       INT(10)      NOT NULL DEFAULT 0 COMMENT 'ICU',
    expires_at  BIGINT(20)   NOT NULL COMMENT 'ICU',
    PRIMARY KEY(counter_key),
    KEY rate_limit_counters_expires_at(expires_at)
);

DROP TABLE IF EXISTS sessions;

CREATE TABLE IF NOT EXISTS sessions (
    session_code VARCHAR(50) NOT NULL COMMENT 'ICU',
    session_json TEXT        NOT NULL COMMENT 'ICU',
    PRIMARY KEY(session_code)
);

DROP TABLE IF EXISTS users;

CREATE TABLE IF NOT EXISTS users (
    id                       INT(11)      NOT NULL AUTO_INCREMENT COMMENT 'ICU',
    username                 VARCHAR(255) NOT NULL COMMENT 'ICU',
    email                    VARCHAR(255) NOT NULL COMMENT 'ICU',
    name                     VARCHAR(80)  DEFAULT '' COMMENT 'ICU',
    nickname                 VARCHAR(20)  DEFAULT '' COMMENT 'ICU',
    avatar_image             VARCHAR(255) DEFAULT '',
    verified_at              TIMESTAMP    NULL DEFAULT NULL,
    hashed_password          VARCHAR(255) DEFAULT NULL,
    invitation_code          VARCHAR(64)  DEFAULT '',
    modules_tags             VARCHAR(255) DEFAULT 'user',
    previous_hashed_password VARCHAR(255) DEFAULT NULL,
    display                  VARCHAR(255) GENERATED ALWAYS AS(COALESCE(nickname, name, email, username)) VIRTUAL,
    created_at               TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at               TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP(),
    archived_at              TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id      INT(10)      DEFAULT NULL,
    PRIMARY KEY(id),
    UNIQUE KEY users_username_unique(username),
    KEY users_email(email),
    KEY users_archived_at(archived_at)
);
