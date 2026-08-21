DROP TABLE IF EXISTS modules;

CREATE TABLE modules (
    id                  INTEGER   PRIMARY KEY,
    code                TEXT      NOT NULL DEFAULT 'default',
    name                TEXT      NOT NULL DEFAULT 'default',
    description         TEXT      DEFAULT '',
    display             TEXT      GENERATED ALWAYS AS(name) VIRTUAL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP DEFAULT NULL,
    archived_by_user_id INTEGER   DEFAULT NULL
);

CREATE UNIQUE INDEX modules_code_unique ON modules(code);

CREATE INDEX modules_archived_at ON modules(archived_at);

CREATE TRIGGER modules_updated_at_trigger AFTER UPDATE ON modules FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE modules
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

INSERT OR IGNORE INTO modules (code, name) VALUES
('default','Default'),
('user','User'),
('system','System Administration'),
('admin','Administration'),
('reeman','Reepolee Manager'),
('examples','Examples');

DROP TABLE IF EXISTS db_tables;

-- Metadata snapshot of the DB's own tables, repopulated from the DDL cache on
-- each /reeman/tables load. Read-only from the CRUD's perspective - rows are
-- never created/edited by hand, only refreshed wholesale.
CREATE TABLE db_tables (
    id           INTEGER   PRIMARY KEY,
    name         TEXT      NOT NULL,
    column_count INTEGER   NOT NULL DEFAULT 0,
    fk_count     INTEGER   NOT NULL DEFAULT 0,
    has_crud     INTEGER   NOT NULL DEFAULT 0,
    display      TEXT      GENERATED ALWAYS AS(name) VIRTUAL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX db_tables_name_unique ON db_tables(name);

CREATE TRIGGER db_tables_updated_at_trigger AFTER UPDATE ON db_tables FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE db_tables
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

DROP TABLE IF EXISTS db_routes;

-- Metadata snapshot of generated routes, repopulated from routes.ts + schema
-- folders on each /reeman/routes load. Read-only from the CRUD's perspective -
-- rows are never created/edited by hand, only refreshed wholesale.
CREATE TABLE db_routes (
    id         INTEGER   PRIMARY KEY,
    url        TEXT      NOT NULL,
    table_name TEXT      NOT NULL DEFAULT '',
    module     TEXT      NOT NULL DEFAULT '',
    removable  INTEGER   NOT NULL DEFAULT 0,
    display    TEXT      GENERATED ALWAYS AS(url) VIRTUAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX db_routes_url_unique ON db_routes(url);

CREATE TRIGGER db_routes_updated_at_trigger AFTER UPDATE ON db_routes FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE db_routes
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
    session_code TEXT NOT NULL,
    session_json TEXT NOT NULL,
    display      TEXT GENERATED ALWAYS AS(session_code) VIRTUAL,
    PRIMARY KEY(session_code)
);

DROP TABLE IF EXISTS rate_limit_counters;

CREATE TABLE rate_limit_counters (
    counter_key TEXT    NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    display     TEXT    GENERATED ALWAYS AS(counter_key) VIRTUAL,
    PRIMARY KEY(counter_key)
);

CREATE INDEX rate_limit_counters_expires_at ON rate_limit_counters(expires_at);

DROP TABLE IF EXISTS images;

CREATE TABLE images (
    id                  INTEGER   PRIMARY KEY,
    folder              TEXT      NOT NULL DEFAULT '/',
    filename            TEXT      NOT NULL,
    s3_key              TEXT      NOT NULL,
    original_filename   TEXT      DEFAULT '',
    title               TEXT      DEFAULT '',
    description         TEXT      DEFAULT NULL,
    tags                TEXT      DEFAULT '',
    mime_type           TEXT      NOT NULL DEFAULT 'image/webp',
    width               INTEGER   NOT NULL DEFAULT 0,
    height              INTEGER   NOT NULL DEFAULT 0,
    file_size           INTEGER   NOT NULL DEFAULT 0,
    display             TEXT      GENERATED ALWAYS AS(COALESCE(NULLIF(title, ''), NULLIF(original_filename, ''), filename)) VIRTUAL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP DEFAULT NULL,
    archived_by_user_id INTEGER   DEFAULT NULL,
    UNIQUE(folder, filename)
);

CREATE INDEX images_archived_at ON images(archived_at);

CREATE TRIGGER images_updated_at_trigger AFTER UPDATE ON images FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE images
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

DROP TABLE IF EXISTS files;

CREATE TABLE files (
    id                  INTEGER   PRIMARY KEY,
    folder              TEXT      NOT NULL DEFAULT '/',
    filename            TEXT      NOT NULL,
    s3_key              TEXT      NOT NULL,
    original_filename   TEXT      DEFAULT '',
    title               TEXT      DEFAULT '',
    description         TEXT      DEFAULT NULL,
    tags                TEXT      DEFAULT '',
    mime_type           TEXT      NOT NULL DEFAULT 'application/octet-stream',
    file_type           TEXT      DEFAULT '',
    file_size           INTEGER   NOT NULL DEFAULT 0,
    -- Soft FK to users.id by naming convention only (no REFERENCES constraint).
-- Set on every upload from the authenticated session (M4 of
-- PLAN_image_file_manager_extraction.md); scopes a user-facing route to
-- 'my files only' via a global_scopes row (uploaded_by_user_id = ::session.user.id).
uploaded_by_user_id INTEGER   NOT NULL DEFAULT 0,
    display             TEXT      GENERATED ALWAYS AS(COALESCE(NULLIF(title, ''), NULLIF(original_filename, ''), filename)) VIRTUAL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP DEFAULT NULL,
    archived_by_user_id INTEGER   DEFAULT NULL,
    UNIQUE(folder, filename)
);

CREATE INDEX files_archived_at ON files(archived_at);

CREATE TRIGGER files_updated_at_trigger AFTER UPDATE ON files FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE files
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

DROP VIEW IF EXISTS v_table_counts;

CREATE VIEW v_table_counts AS
SELECT
    CAST('images' AS TEXT) AS display,
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
    i.folder || '__' ||
    i.filename || '__' ||
    i.s3_key || '__' ||
    COALESCE(i.original_filename, '') || '__' ||
    COALESCE(i.title, '') || '__' ||
    COALESCE(i.description, '') || '__' ||
    COALESCE(i.tags, '') || '__' ||
    i.mime_type AS search_text
FROM images i
    LEFT JOIN users u
        ON u.id = i.archived_by_user_id;

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
    f.folder || '__' ||
    f.filename || '__' ||
    f.s3_key || '__' ||
    COALESCE(f.original_filename, '') || '__' ||
    COALESCE(f.title, '') || '__' ||
    COALESCE(f.description, '') || '__' ||
    COALESCE(f.tags, '') || '__' ||
    f.mime_type AS search_text
FROM files f
    LEFT JOIN users u
        ON u.id = f.archived_by_user_id;

DROP TABLE IF EXISTS global_scopes;

CREATE TABLE global_scopes (
    id                  INTEGER   PRIMARY KEY,
    module_code         TEXT      NOT NULL DEFAULT '',
    feature_name        TEXT      NOT NULL DEFAULT '',
    table_name          TEXT      NOT NULL,
    scope_key           TEXT      NOT NULL,
    display_name        TEXT      NOT NULL DEFAULT '',
    where_clause        TEXT      NOT NULL,
    sort_order          INTEGER   NOT NULL DEFAULT 0,
    is_default          INTEGER   NOT NULL DEFAULT 0,
    display             TEXT      GENERATED ALWAYS AS(module_code || ':' || feature_name || ':' || table_name || ':' || scope_key) VIRTUAL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP DEFAULT NULL,
    archived_by_user_id INTEGER   DEFAULT NULL,
    UNIQUE(module_code, feature_name, table_name, scope_key)
);

CREATE INDEX global_scopes_archived_at ON global_scopes(archived_at);

CREATE TRIGGER global_scopes_updated_at_trigger AFTER UPDATE ON global_scopes FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE global_scopes
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

-- 'My files' ownership scope (M4 of PLAN_image_file_manager_extraction.md):
-- scopes a user-facing route over the files table to rows the current user
-- uploaded. Populated on every upload via uploaded_by_user_id. Reeman admin
-- routes never resolve scopes (they pass an empty scope_clause), so this does
-- not affect the sysadmin files UI.
INSERT OR IGNORE INTO global_scopes (module_code, feature_name, table_name, scope_key, display_name, where_clause, sort_order, is_default) VALUES
('user','','files','my_files','My files','uploaded_by_user_id = ::session.user.id',0,1);

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
    display                  TEXT      GENERATED ALWAYS AS(COALESCE(NULLIF(name, ''), username)) VIRTUAL,
    created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at              TIMESTAMP DEFAULT NULL,
    archived_by_user_id      INTEGER   DEFAULT NULL
);

-- email is not unique - username is the primary identifier
CREATE UNIQUE INDEX users_username_unique ON users(username);

CREATE INDEX users_email ON users(email);
CREATE INDEX users_archived_at ON users(archived_at);

CREATE TRIGGER users_updated_at_trigger AFTER UPDATE ON users FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE users
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;
