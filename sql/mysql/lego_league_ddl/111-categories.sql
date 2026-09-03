-- MySQL 8.0+ LEGO League schema
-- Table: categories

CREATE TABLE IF NOT EXISTS categories (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    code                VARCHAR(255) DEFAULT '',
    title               VARCHAR(255) DEFAULT '',
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    option_display      VARCHAR(255) GENERATED ALWAYS AS(CONCAT(code, CASE WHEN COALESCE(title, '')= '' THEN '' ELSE CONCAT(' - ', title) END)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX categories_code ON categories(code);

CREATE INDEX categories_title ON categories(title);

CREATE INDEX categories_archived_at ON categories(archived_at);
