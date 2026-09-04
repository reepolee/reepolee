-- Web Push subscriptions. The endpoint hash avoids backend-specific index-length
-- limits while the full endpoint remains available for delivery.
DROP TABLE IF EXISTS web_push_subscriptions;

CREATE TABLE web_push_subscriptions (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    user_id       INT UNSIGNED NOT NULL COMMENT 'ICU',
    endpoint      TEXT         NOT NULL COMMENT '',
    endpoint_hash CHAR(64)     NOT NULL COMMENT 'ICU',
    p256dh        VARCHAR(255) NOT NULL COMMENT 'ICU',
    auth          VARCHAR(255) NOT NULL COMMENT 'ICU',
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY web_push_subscriptions_endpoint_hash_unique(endpoint_hash),
    INDEX web_push_subscriptions_user_id(user_id)
) COMMENT '';
