-- MySQL 8.0+ LEGO League schema
-- Table: tournament_teams

CREATE TABLE IF NOT EXISTS tournament_teams (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    tournament_id       INT          NOT NULL,
    team_id             INT          NOT NULL,
    is_present          TINYINT      NOT NULL DEFAULT 0,
    checked_in_at       TIMESTAMP    DEFAULT NULL,
    notes               TEXT         DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT(CAST(tournament_id AS CHAR), ' - ', CAST(team_id AS CHAR))) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX tournament_teams_tournament_id ON tournament_teams(tournament_id);

CREATE INDEX tournament_teams_team_id ON tournament_teams(team_id);

CREATE INDEX tournament_teams_archived_at ON tournament_teams(archived_at);
