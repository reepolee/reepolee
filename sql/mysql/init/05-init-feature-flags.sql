DROP TABLE IF EXISTS feature_flags;

CREATE TABLE feature_flags (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    name                VARCHAR(128) NOT NULL COMMENT 'ICU',
    is_enabled          TINYINT(1)   NULL DEFAULT 0 COMMENT '',
    rollout_pct         INT          NOT NULL DEFAULT 100 COMMENT '',
    description         VARCHAR(255) NOT NULL DEFAULT '' COMMENT '',
    display             VARCHAR(128) GENERATED ALWAYS AS (name) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    NULL DEFAULT NULL,
    archived_by_user_id INT UNSIGNED NULL DEFAULT NULL
) COMMENT '';

CREATE UNIQUE INDEX feature_flags_name_unique ON feature_flags(name);

CREATE INDEX feature_flags_archived_at ON feature_flags(archived_at);

DROP VIEW IF EXISTS v_feature_flags;

CREATE VIEW v_feature_flags AS
SELECT
    f.id,
    f.display,
    f.name,
    f.is_enabled,
    f.rollout_pct,
    f.description,
    f.archived_at,
    f.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    f.created_at,
    f.updated_at,
    CONCAT_WS('__', f.name, f.description) AS search_text
FROM feature_flags f
    LEFT JOIN users u
        ON u.id = f.archived_by_user_id;
