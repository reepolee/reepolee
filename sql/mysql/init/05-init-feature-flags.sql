DROP VIEW IF EXISTS v_feature_flags;

DROP TABLE IF EXISTS feature_flags;

CREATE TABLE IF NOT EXISTS feature_flags (
    id                  INT(10)      NOT NULL AUTO_INCREMENT COMMENT 'ICU',
    name                VARCHAR(128) NOT NULL COMMENT 'ICU',
    is_enabled          TINYINT(1)   DEFAULT 0,
    rollout_pct         INT(11)      NOT NULL DEFAULT 100,
    description         VARCHAR(255) NOT NULL DEFAULT '',
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT(10)      DEFAULT NULL,
    PRIMARY KEY(id),
    UNIQUE KEY feature_flags_name_unique(name),
    KEY feature_flags_archived_at(archived_at)
);

CREATE VIEW v_feature_flags AS
SELECT
    f.id                  AS id,
    f.name                AS name,
    f.is_enabled          AS is_enabled,
    f.rollout_pct         AS rollout_pct,
    f.description         AS description,
    f.archived_at         AS archived_at,
    f.archived_by_user_id AS archived_by_user_id,
    u.display             AS archived_by_user_display,
    f.created_at          AS created_at,
    f.updated_at          AS updated_at,
    CONCAT_WS('__', f.name, f.description) AS search_text
FROM feature_flags f
    LEFT JOIN users u
        ON(u.id = f.archived_by_user_id);
