-- MySQL 8.0+ LEGO League schema
-- Table: season_statuses

CREATE TABLE IF NOT EXISTS season_statuses (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    title               VARCHAR(255) DEFAULT '',
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX season_statuses_title ON season_statuses(title);

CREATE INDEX season_statuses_archived_at ON season_statuses(archived_at);
