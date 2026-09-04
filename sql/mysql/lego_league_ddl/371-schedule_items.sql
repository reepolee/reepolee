-- MySQL 8.0+ LEGO League schema
-- Table: schedule_items

CREATE TABLE IF NOT EXISTS schedule_items (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    tournament_id       INT          NOT NULL,
    title               VARCHAR(255) NOT NULL,
    start_time          VARCHAR(255) NOT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(title) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX schedule_items_tournament_id ON schedule_items(tournament_id);

CREATE INDEX schedule_items_archived_at ON schedule_items(archived_at);
