-- MySQL 8.0+ LEGO League schema
-- Table: tournament_volunteers

CREATE TABLE IF NOT EXISTS tournament_volunteers (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    tournament_id       INT          NOT NULL,
    volunteer_id        INT          NOT NULL,
    role_id             INT          NOT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT(CAST(tournament_id AS CHAR), ' - ', CAST(volunteer_id AS CHAR))) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE,
    FOREIGN KEY(volunteer_id) REFERENCES volunteers(id) ON UPDATE CASCADE,
    FOREIGN KEY(role_id) REFERENCES roles(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX tournament_volunteers_tournament_id ON tournament_volunteers(tournament_id);

CREATE INDEX tournament_volunteers_volunteer_id ON tournament_volunteers(volunteer_id);

CREATE INDEX tournament_volunteers_role_id ON tournament_volunteers(role_id);

CREATE INDEX tournament_volunteers_archived_at ON tournament_volunteers(archived_at);
