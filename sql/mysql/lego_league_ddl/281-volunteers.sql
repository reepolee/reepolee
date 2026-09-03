-- MySQL 8.0+ LEGO League schema
-- Table: volunteers

CREATE TABLE IF NOT EXISTS volunteers (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    title               VARCHAR(255) NOT NULL,
    email               VARCHAR(255) DEFAULT NULL,
    phone_number        VARCHAR(255) DEFAULT NULL,
    notes               TEXT         DEFAULT NULL,
    is_active           TINYINT      NOT NULL DEFAULT 1,
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX volunteers_title ON volunteers(title);

CREATE INDEX volunteers_archived_at ON volunteers(archived_at);
