-- MySQL 8.0+ LEGO League schema
-- Table: seasons

CREATE TABLE IF NOT EXISTS seasons (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    title               VARCHAR(255) NOT NULL,
    status_id           INT          NOT NULL,
    starts_on           VARCHAR(255) NOT NULL,
    ends_on             VARCHAR(255) DEFAULT NULL,
    description         TEXT         DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(status_id) REFERENCES season_statuses(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX seasons_status_id ON seasons(status_id);

CREATE INDEX seasons_title ON seasons(title);

CREATE INDEX seasons_archived_at ON seasons(archived_at);
