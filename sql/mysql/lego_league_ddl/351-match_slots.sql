-- MySQL 8.0+ LEGO League schema
-- Table: match_slots

CREATE TABLE IF NOT EXISTS match_slots (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    tournament_id       INT          NOT NULL,
    round_number        INT          NOT NULL,
    start_time          VARCHAR(255) NOT NULL,
    table_1_id          INT          DEFAULT NULL,
    table_2_id          INT          DEFAULT NULL,
    team_1_id           INT          DEFAULT NULL,
    team_2_id           INT          DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT('Round ', CAST(round_number AS CHAR))) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE,
    FOREIGN KEY(table_1_id) REFERENCES arena_tables(id) ON UPDATE CASCADE,
    FOREIGN KEY(table_2_id) REFERENCES arena_tables(id) ON UPDATE CASCADE,
    FOREIGN KEY(team_1_id) REFERENCES teams(id) ON UPDATE CASCADE,
    FOREIGN KEY(team_2_id) REFERENCES teams(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX match_slots_tournament_id ON match_slots(tournament_id);

CREATE INDEX match_slots_table_1_id ON match_slots(table_1_id);

CREATE INDEX match_slots_table_2_id ON match_slots(table_2_id);

CREATE INDEX match_slots_team_1_id ON match_slots(team_1_id);

CREATE INDEX match_slots_team_2_id ON match_slots(team_2_id);

CREATE INDEX match_slots_archived_at ON match_slots(archived_at);
