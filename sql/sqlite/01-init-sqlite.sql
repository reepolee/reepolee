DROP TABLE IF EXISTS modules;

CREATE TABLE modules (
    id          INTEGER   PRIMARY KEY,
    code        TEXT      NOT NULL DEFAULT 'default',
    name        TEXT      NOT NULL DEFAULT 'default',
    description TEXT      DEFAULT '',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX modules_code_unique ON modules(code);

CREATE TRIGGER modules_updated_at_trigger AFTER UPDATE ON modules FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE modules SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

INSERT OR IGNORE INTO modules (code, name) VALUES
('default','Default'),
('user','User'),
('system','System Administration'),
('admin','Administration'),
('examples','Examples');

DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
    session_code TEXT NOT NULL,
    session_json TEXT NOT NULL,
    PRIMARY KEY(session_code)
);

DROP TABLE IF EXISTS rate_limit_counters;

CREATE TABLE rate_limit_counters (
    counter_key TEXT    NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    PRIMARY KEY(counter_key)
);

CREATE INDEX rate_limit_counters_expires_at ON rate_limit_counters(expires_at);

DROP TABLE IF EXISTS images;

CREATE TABLE images (
    id                INTEGER   PRIMARY KEY,
    folder            TEXT      NOT NULL DEFAULT '/',
    filename          TEXT      NOT NULL,
    s3_key            TEXT      NOT NULL,
    original_filename TEXT      DEFAULT '',
    title             TEXT      DEFAULT '',
    description       TEXT      DEFAULT NULL,
    tags              TEXT      DEFAULT '',
    mime_type         TEXT      NOT NULL DEFAULT 'image/webp',
    width             INTEGER   NOT NULL DEFAULT 0,
    height            INTEGER   NOT NULL DEFAULT 0,
    file_size         INTEGER   NOT NULL DEFAULT 0,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(folder, filename)
);

CREATE TRIGGER images_updated_at_trigger AFTER UPDATE ON images FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE images SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

DROP TABLE IF EXISTS files;

CREATE TABLE files (
    id                INTEGER   PRIMARY KEY,
    folder            TEXT      NOT NULL DEFAULT '/',
    filename          TEXT      NOT NULL,
    s3_key            TEXT      NOT NULL,
    original_filename TEXT      DEFAULT '',
    title             TEXT      DEFAULT '',
    description       TEXT      DEFAULT NULL,
    tags              TEXT      DEFAULT '',
    mime_type         TEXT      NOT NULL DEFAULT 'application/octet-stream',
    file_type         TEXT      DEFAULT '',
    file_size         INTEGER   NOT NULL DEFAULT 0,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(folder, filename)
);

CREATE TRIGGER files_updated_at_trigger AFTER UPDATE ON files FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE files SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

DROP VIEW IF EXISTS v_table_counts;

CREATE VIEW v_table_counts AS
SELECT
    'images',
    '/system/images',
    COUNT(*)
FROM images UNION ALL SELECT 'files', '/system/files', COUNT(*) FROM files UNION ALL SELECT 'modules', NULL, COUNT(*) FROM modules UNION ALL SELECT 'users', '/system/users', COUNT(*) FROM users;

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
    folder || '__' ||
    filename || '__' ||
    s3_key || '__' ||
    COALESCE(original_filename, '') || '__' ||
    COALESCE(title, '') || '__' ||
    COALESCE(description, '') || '__' ||
    COALESCE(tags, '') || '__' ||
    mime_type AS search_text
FROM images;

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
    folder || '__' ||
    filename || '__' ||
    s3_key || '__' ||
    COALESCE(original_filename, '') || '__' ||
    COALESCE(title, '') || '__' ||
    COALESCE(description, '') || '__' ||
    COALESCE(tags, '') || '__' ||
    mime_type AS search_text
FROM files;

DROP TABLE IF EXISTS global_scopes;

CREATE TABLE global_scopes (
    id           INTEGER   PRIMARY KEY,
    module_code  TEXT      NOT NULL DEFAULT '',
    feature_name TEXT      NOT NULL DEFAULT '',
    table_name   TEXT      NOT NULL,
    scope_key    TEXT      NOT NULL,
    display_name TEXT      NOT NULL DEFAULT '',
    where_clause TEXT      NOT NULL,
    sort_order   INTEGER   NOT NULL DEFAULT 0,
    is_default   INTEGER   NOT NULL DEFAULT 0,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(module_code, feature_name, table_name, scope_key)
);

CREATE TRIGGER global_scopes_updated_at_trigger AFTER UPDATE ON global_scopes FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE global_scopes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

DROP TABLE IF EXISTS translations;

CREATE TABLE translations (
    id          INTEGER   PRIMARY KEY,
    lang        TEXT      NOT NULL,
    namespace   TEXT      NOT NULL DEFAULT '',
    key_path    TEXT      NOT NULL,
    translation TEXT      NOT NULL DEFAULT '',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(lang, namespace, key_path)
);

CREATE TRIGGER translations_updated_at_trigger AFTER UPDATE ON translations FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE translations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id                       INTEGER   PRIMARY KEY,
    username                 TEXT      NOT NULL DEFAULT '',
    email                    TEXT      NOT NULL,
    name                     TEXT      DEFAULT '',
    nickname                 TEXT      DEFAULT '',
    avatar_filename          TEXT      DEFAULT '',
    verified_at              DATETIME  DEFAULT NULL,
    hashed_password          TEXT      DEFAULT NULL,
    invitation_code          TEXT      DEFAULT '',
    modules_tags             TEXT      DEFAULT 'user',
    previous_hashed_password TEXT      DEFAULT NULL,
    created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- email is not unique - username is the primary identifier
CREATE UNIQUE INDEX users_username_unique ON users(username);

CREATE INDEX users_email ON users(email);

CREATE TRIGGER users_updated_at_trigger AFTER UPDATE ON users FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;
