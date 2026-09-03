-- MySQL 8.0+ LEGO League schema
-- Table: feature_flags

CREATE TABLE IF NOT EXISTS feature_flags (
    id                  INT           PRIMARY KEY AUTO_INCREMENT,
    name                VARCHAR(255)  NOT NULL DEFAULT '',
    is_enabled          TINYINT       NOT NULL DEFAULT 0,
    rollout_pct         INT           NOT NULL DEFAULT 100,
    description         VARCHAR(2048) NOT NULL DEFAULT '',
    display             VARCHAR(255)  GENERATED ALWAYS AS(name) VIRTUAL,
    created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP     DEFAULT NULL,
    archived_by_user_id INT           DEFAULT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE UNIQUE INDEX feature_flags_name_unique ON feature_flags(name);

CREATE INDEX feature_flags_archived_at ON feature_flags(archived_at);
