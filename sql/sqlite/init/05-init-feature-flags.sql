DROP TABLE IF EXISTS feature_flags;

CREATE TABLE feature_flags (
    id                  INTEGER   PRIMARY KEY,
    name                TEXT      NOT NULL DEFAULT '',
    is_enabled          INTEGER   NOT NULL DEFAULT 0,
    rollout_pct         INTEGER   NOT NULL DEFAULT 100,
    description         TEXT      NOT NULL DEFAULT '',
    display             TEXT      GENERATED ALWAYS AS(name) VIRTUAL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP DEFAULT NULL,
    archived_by_user_id INTEGER   DEFAULT NULL
);

CREATE UNIQUE INDEX feature_flags_name_unique ON feature_flags(name);

CREATE INDEX feature_flags_archived_at ON feature_flags(archived_at);

CREATE TRIGGER feature_flags_updated_at_trigger AFTER UPDATE ON feature_flags FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE feature_flags
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

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
    f.name || '__' || f.description AS search_text
FROM feature_flags f
    LEFT JOIN users u
        ON u.id = f.archived_by_user_id;
