-- MySQL 8.0+ LEGO League schema
-- Table: awards

CREATE TABLE IF NOT EXISTS awards (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    tournament_id       INT          NOT NULL,
    title               VARCHAR(255) NOT NULL,
    category_id         INT          DEFAULT NULL,
    team_id             INT          DEFAULT NULL,
    description         TEXT         DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON UPDATE CASCADE,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX awards_tournament_id ON awards(tournament_id);

CREATE INDEX awards_category_id ON awards(category_id);

CREATE INDEX awards_team_id ON awards(team_id);

CREATE INDEX awards_archived_at ON awards(archived_at);
