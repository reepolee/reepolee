-- Web Push subscriptions. The endpoint hash avoids backend-specific index-length
-- limits while the full endpoint remains available for delivery.
DROP TABLE IF EXISTS web_push_subscriptions;

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id            INT(10)      NOT NULL AUTO_INCREMENT COMMENT 'ICU',
    user_id       INT(10)      NOT NULL COMMENT 'ICU',
    endpoint      TEXT         NOT NULL,
    endpoint_hash CHAR(64)     NOT NULL COMMENT 'ICU',
    p256dh        VARCHAR(255) NOT NULL COMMENT 'ICU',
    auth          VARCHAR(255) NOT NULL COMMENT 'ICU',
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    updated_at    TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
    PRIMARY KEY(id),
    UNIQUE KEY web_push_subscriptions_endpoint_hash_unique(endpoint_hash),
    KEY web_push_subscriptions_user_id(user_id)
);
