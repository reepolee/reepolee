-- MySQL 8.0+ LEGO League schema
-- Table: points

CREATE TABLE IF NOT EXISTS points (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    tournament_id       INT          NOT NULL,
    team_id             INT          NOT NULL,
    category_id         INT          NOT NULL,
    judge_id            INT          DEFAULT NULL,
    `rank`              INT          DEFAULT NULL,
    points              INT          DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT('Rank ', CAST(`rank` AS CHAR))) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON UPDATE CASCADE,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON UPDATE CASCADE,
    FOREIGN KEY(judge_id) REFERENCES volunteers(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX points_tournament_id ON points(tournament_id);

CREATE INDEX points_team_id ON points(team_id);

CREATE INDEX points_category_id ON points(category_id);

CREATE INDEX points_judge_id ON points(judge_id);

CREATE INDEX points_archived_at ON points(archived_at);
