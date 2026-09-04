-- MySQL 8.0+ LEGO League schema
-- Table: teams

CREATE TABLE IF NOT EXISTS teams (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    title               VARCHAR(255) NOT NULL,
    school              VARCHAR(255) DEFAULT '',
    country_code        VARCHAR(3)   NOT NULL DEFAULT 'SI',
    season_id           INT          NOT NULL,
    status_id           INT          NOT NULL,
    coach_name          VARCHAR(255) DEFAULT NULL,
    coach_email         VARCHAR(255) DEFAULT NULL,
    coach_phone         VARCHAR(255) DEFAULT NULL,
    coach_2_name        VARCHAR(255) DEFAULT NULL,
    coach_2_email       VARCHAR(255) DEFAULT NULL,
    coach_2_phone       VARCHAR(255) DEFAULT NULL,
    address             VARCHAR(255) DEFAULT NULL,
    postal_code         VARCHAR(255) DEFAULT NULL,
    city                VARCHAR(255) DEFAULT NULL,
    package_code        VARCHAR(255) DEFAULT NULL,
    package_name        VARCHAR(255) DEFAULT NULL,
    is_paid             TINYINT      NOT NULL DEFAULT 0,
    paid_on             VARCHAR(255) DEFAULT NULL,
    external_id         VARCHAR(255) DEFAULT NULL,
    imported_at         TIMESTAMP    DEFAULT NULL,
    search_text         TEXT         DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    option_display      VARCHAR(255) GENERATED ALWAYS AS(CONCAT(title, CASE WHEN COALESCE(school, '')= '' THEN '' ELSE CONCAT(' - ', school) END)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(season_id) REFERENCES seasons(id) ON UPDATE CASCADE,
    FOREIGN KEY(status_id) REFERENCES team_statuses(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX teams_title ON teams(title);

CREATE INDEX teams_school ON teams(school);

CREATE INDEX teams_country_code ON teams(country_code);

CREATE INDEX teams_season_id ON teams(season_id);

CREATE INDEX teams_status_id ON teams(status_id);

CREATE INDEX teams_archived_at ON teams(archived_at);

CREATE UNIQUE INDEX teams_external_id_unique ON teams(external_id);
