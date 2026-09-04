-- MySQL 8.0+ LEGO League schema
-- Table: global_scopes

CREATE TABLE IF NOT EXISTS global_scopes (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    module_code         VARCHAR(255) NOT NULL DEFAULT '',
    feature_name        VARCHAR(255) NOT NULL DEFAULT '',
    table_name          VARCHAR(255) NOT NULL,
    scope_key           VARCHAR(255) NOT NULL,
    display_name        VARCHAR(255) NOT NULL DEFAULT '',
    where_clause        TEXT         NOT NULL,
    sort_order          INT          NOT NULL DEFAULT 0,
    is_default          TINYINT      NOT NULL DEFAULT 0,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT(module_code, ':', feature_name, ':', table_name, ':', scope_key)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    UNIQUE(module_code, feature_name, table_name, scope_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX global_scopes_archived_at ON global_scopes(archived_at);
