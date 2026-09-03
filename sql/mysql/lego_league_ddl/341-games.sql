-- MySQL 8.0+ LEGO League schema
-- Table: games

CREATE TABLE IF NOT EXISTS games (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    tournament_id       INT          NOT NULL,
    team_id             INT          NOT NULL,
    round_number        INT          NOT NULL,
    referee_id          INT          DEFAULT NULL,
    table_id            INT          DEFAULT NULL,
    points              INT          NOT NULL DEFAULT 0,
    gp                  INT          NOT NULL DEFAULT 3,
    missions            LONGTEXT     DEFAULT('[]'),
    signature           TEXT         DEFAULT NULL,
    is_acknowledged     TINYINT      NOT NULL DEFAULT 0,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT('Round ', CAST(round_number AS CHAR))) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON UPDATE CASCADE,
    FOREIGN KEY(referee_id) REFERENCES volunteers(id) ON UPDATE CASCADE,
    FOREIGN KEY(table_id) REFERENCES arena_tables(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX games_tournament_id ON games(tournament_id);

CREATE INDEX games_team_id ON games(team_id);

CREATE INDEX games_referee_id ON games(referee_id);

CREATE INDEX games_table_id ON games(table_id);

CREATE INDEX games_archived_at ON games(archived_at);
