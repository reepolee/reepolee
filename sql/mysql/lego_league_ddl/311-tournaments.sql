-- MySQL 8.0+ LEGO League schema
-- Table: tournaments

CREATE TABLE IF NOT EXISTS tournaments (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    season_id           INT          NOT NULL,
    tournament_type_id  INT          NOT NULL,
    status_id           INT          NOT NULL,
    title               VARCHAR(255) NOT NULL,
    location            VARCHAR(255) DEFAULT '',
    starts_on           VARCHAR(255) NOT NULL,
    ends_on             VARCHAR(255) DEFAULT NULL,
    rounds              INT          NOT NULL DEFAULT 3,
    has_test_round      TINYINT      NOT NULL DEFAULT 0,
    current_round       INT          NOT NULL DEFAULT 1,
    teams_advancing     INT          NOT NULL DEFAULT 0,
    teams_waiting       INT          NOT NULL DEFAULT 0,
    head_referee_id     INT          DEFAULT NULL,
    description         TEXT         DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    option_display      VARCHAR(255) GENERATED ALWAYS AS(CONCAT(title, CASE WHEN COALESCE(LOCATION, '')= '' THEN '' ELSE CONCAT(' - ', LOCATION) END)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(season_id) REFERENCES seasons(id) ON UPDATE CASCADE,
    FOREIGN KEY(tournament_type_id) REFERENCES tournament_types(id) ON UPDATE CASCADE,
    FOREIGN KEY(status_id) REFERENCES tournament_statuses(id) ON UPDATE CASCADE,
    FOREIGN KEY(head_referee_id) REFERENCES volunteers(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX tournaments_season_id ON tournaments(season_id);

CREATE INDEX tournaments_tournament_type_id ON tournaments(tournament_type_id);

CREATE INDEX tournaments_status_id ON tournaments(status_id);

CREATE INDEX tournaments_head_referee_id ON tournaments(head_referee_id);

CREATE INDEX tournaments_title ON tournaments(title);

CREATE INDEX tournaments_archived_at ON tournaments(archived_at);
