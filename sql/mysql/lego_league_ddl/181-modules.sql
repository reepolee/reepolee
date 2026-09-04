-- MySQL 8.0+ LEGO League schema
-- Table: modules

CREATE TABLE IF NOT EXISTS modules (
    id                  INT           PRIMARY KEY AUTO_INCREMENT,
    code                VARCHAR(255)  NOT NULL DEFAULT 'default',
    name                VARCHAR(255)  NOT NULL DEFAULT 'default',
    description         VARCHAR(2048) DEFAULT '',
    display             VARCHAR(255)  GENERATED ALWAYS AS(name) VIRTUAL,
    created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP     DEFAULT NULL,
    archived_by_user_id INT           DEFAULT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE UNIQUE INDEX modules_code_unique ON modules(code);

CREATE INDEX modules_archived_at ON modules(archived_at);
