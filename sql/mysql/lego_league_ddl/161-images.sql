-- MySQL 8.0+ LEGO League schema
-- Table: images

CREATE TABLE IF NOT EXISTS images (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    folder              VARCHAR(255) NOT NULL DEFAULT '/',
    filename            VARCHAR(255) NOT NULL,
    s3_key              VARCHAR(255) NOT NULL,
    original_filename   VARCHAR(255) DEFAULT '',
    title               VARCHAR(255) DEFAULT '',
    description         TEXT         DEFAULT NULL,
    tags                VARCHAR(255) DEFAULT '',
    mime_type           VARCHAR(255) NOT NULL DEFAULT 'image/webp',
    width               INT          NOT NULL DEFAULT 0,
    height              INT          NOT NULL DEFAULT 0,
    file_size           BIGINT       NOT NULL DEFAULT 0,
    display             VARCHAR(255) GENERATED ALWAYS AS(COALESCE(NULLIF(title, ''), NULLIF(original_filename, ''), filename)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    UNIQUE(folder, filename)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX images_archived_at ON images(archived_at);
