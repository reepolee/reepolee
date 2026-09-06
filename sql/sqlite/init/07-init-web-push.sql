-- Web Push subscriptions. The endpoint hash avoids backend-specific index-length
-- limits while the full endpoint remains available for delivery.
DROP TABLE IF EXISTS web_push_subscriptions;

CREATE TABLE web_push_subscriptions (
    id            INTEGER   PRIMARY KEY,
    user_id       INTEGER   NOT NULL,
    endpoint      TEXT      NOT NULL,
    display       TEXT      GENERATED ALWAYS AS(endpoint) VIRTUAL,
    endpoint_hash TEXT      NOT NULL,
    p256dh        TEXT      NOT NULL,
    auth          TEXT      NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX web_push_subscriptions_endpoint_hash_unique ON web_push_subscriptions(endpoint_hash);

CREATE INDEX web_push_subscriptions_user_id ON web_push_subscriptions(user_id);

CREATE TRIGGER web_push_subscriptions_updated_at_trigger AFTER UPDATE ON web_push_subscriptions FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE web_push_subscriptions
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;
