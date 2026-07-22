DROP TABLE IF EXISTS feature_flags;

CREATE TABLE feature_flags (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    name         VARCHAR(128) NOT NULL COMMENT 'ICU',
    is_enabled   TINYINT(1)   NULL DEFAULT 0 COMMENT '',
    rollout_pct  INT          NOT NULL DEFAULT 100 COMMENT '',
    description  VARCHAR(255) NOT NULL DEFAULT '' COMMENT '',
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '';

CREATE UNIQUE INDEX feature_flags_name_unique ON feature_flags(name);

DROP VIEW IF EXISTS v_feature_flags;

CREATE VIEW v_feature_flags AS
SELECT
    id,
    name,
    is_enabled,
    rollout_pct,
    description,
    created_at,
    updated_at,
    CONCAT_WS('__', name, description) AS search_text
FROM feature_flags;
