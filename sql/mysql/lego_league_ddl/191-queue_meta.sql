-- MySQL 8.0+ LEGO League schema
-- Table: queue_meta

CREATE TABLE IF NOT EXISTS queue_meta (
    meta_key   VARCHAR(255) NOT NULL,
    meta_value VARCHAR(255) NOT NULL DEFAULT '',
    display    VARCHAR(255) GENERATED ALWAYS AS(meta_key) VIRTUAL,
    PRIMARY KEY(meta_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
