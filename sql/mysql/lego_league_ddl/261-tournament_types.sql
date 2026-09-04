-- MySQL 8.0+ LEGO League schema
-- Table: tournament_types

CREATE TABLE IF NOT EXISTS tournament_types (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    title               VARCHAR(255) DEFAULT '',
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX tournament_types_title ON tournament_types(title);

CREATE INDEX tournament_types_archived_at ON tournament_types(archived_at);
