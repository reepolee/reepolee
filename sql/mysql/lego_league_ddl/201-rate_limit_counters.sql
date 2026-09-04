-- MySQL 8.0+ LEGO League schema
-- Table: rate_limit_counters

CREATE TABLE IF NOT EXISTS rate_limit_counters (
    counter_key VARCHAR(255) NOT NULL,
    count       INT          NOT NULL DEFAULT 0,
    expires_at  BIGINT       NOT NULL,
    display     VARCHAR(255) GENERATED ALWAYS AS(counter_key) VIRTUAL,
    PRIMARY KEY(counter_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX rate_limit_counters_expires_at ON rate_limit_counters(expires_at);
