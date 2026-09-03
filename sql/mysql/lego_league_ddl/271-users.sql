-- MySQL 8.0+ LEGO League schema
-- Table: users

CREATE TABLE IF NOT EXISTS users (
    id                       INT          PRIMARY KEY AUTO_INCREMENT,
    username                 VARCHAR(255) NOT NULL DEFAULT '',
    email                    VARCHAR(255) NOT NULL,
    name                     VARCHAR(255) DEFAULT '',
    nickname                 VARCHAR(255) DEFAULT '',
    avatar_filename          VARCHAR(255) DEFAULT '',
    verified_at              DATETIME     DEFAULT NULL,
    hashed_password          VARCHAR(255) DEFAULT NULL,
    invitation_code          VARCHAR(255) DEFAULT '',
    modules_tags             VARCHAR(255) DEFAULT 'user',
    previous_hashed_password VARCHAR(255) DEFAULT NULL,
    display                  VARCHAR(255) GENERATED ALWAYS AS(COALESCE(NULLIF(name, ''), username)) VIRTUAL,
    created_at               TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at              TIMESTAMP    DEFAULT NULL,
    archived_by_user_id      INT          DEFAULT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE UNIQUE INDEX users_username_unique ON users(username);

CREATE INDEX users_email ON users(email);

CREATE INDEX users_archived_at ON users(archived_at);
