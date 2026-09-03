-- MySQL 8.0+ LEGO League schema
-- Table: sessions

CREATE TABLE IF NOT EXISTS sessions (
    session_code VARCHAR(255) NOT NULL,
    session_json LONGTEXT     NOT NULL,
    display      VARCHAR(255) GENERATED ALWAYS AS(session_code) VIRTUAL,
    PRIMARY KEY(session_code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
