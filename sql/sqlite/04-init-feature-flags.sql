DROP TABLE IF EXISTS feature_flags;

CREATE TABLE feature_flags (
    id           INTEGER   PRIMARY KEY,
    name         TEXT      NOT NULL DEFAULT '',
    is_enabled   INTEGER   NOT NULL DEFAULT 0,
    rollout_pct  INTEGER   NOT NULL DEFAULT 100,
    description  TEXT      NOT NULL DEFAULT '',
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX feature_flags_name_unique ON feature_flags(name);

CREATE TRIGGER feature_flags_updated_at_trigger AFTER UPDATE ON feature_flags FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE feature_flags SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

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
    name || '__' || description AS search_text
FROM feature_flags;
