-- MySQL 8.0+ LEGO League schema
-- Table: team_members

CREATE TABLE IF NOT EXISTS team_members (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    team_id             INT          NOT NULL,
    first_name          VARCHAR(255) NOT NULL,
    last_name           VARCHAR(255) NOT NULL,
    birth_year          INT          DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(CONCAT(first_name, CASE WHEN COALESCE(last_name, '')= '' THEN '' ELSE CONCAT(' ', last_name) END)) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX team_members_team_id ON team_members(team_id);

CREATE INDEX team_members_archived_at ON team_members(archived_at);
