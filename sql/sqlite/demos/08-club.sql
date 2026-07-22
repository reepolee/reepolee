DROP VIEW IF EXISTS v_members;
DROP VIEW IF EXISTS v_teams;

DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS clubs;

CREATE TABLE clubs (
    id          INTEGER  PRIMARY KEY AUTOINCREMENT,
    name        TEXT     NOT NULL,
    description TEXT     DEFAULT '',
    logo_image  TEXT     DEFAULT '',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT NULL
);

CREATE INDEX clubs_name ON clubs(name);

CREATE TRIGGER clubs_update_timestamp AFTER UPDATE ON clubs FOR EACH ROW BEGIN
    UPDATE clubs
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

INSERT INTO clubs (id, name, description) VALUES
(1,'Polka High Basketball Club','Go, Tigers!'),
(2,'Polka High Chess club','3x National champions');

CREATE TABLE teams (
    id          INTEGER  PRIMARY KEY AUTOINCREMENT,
    club_id     INTEGER  NOT NULL,
    name        TEXT     NOT NULL,
    description TEXT     NOT NULL DEFAULT '',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT NULL,
    FOREIGN KEY(club_id) REFERENCES clubs(id) ON UPDATE CASCADE
);

CREATE INDEX teams_name ON teams(name);

CREATE TRIGGER teams_update_timestamp AFTER UPDATE ON teams FOR EACH ROW BEGIN
    UPDATE teams
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

CREATE VIEW IF NOT EXISTS v_teams AS
SELECT
    t.id,
    t.club_id,
    c.name AS club_name,
    t.name,
    t.description,
    t.created_at,
    t.updated_at
FROM teams t
    LEFT JOIN clubs c
        ON t.club_id = c.id;

INSERT INTO teams (id, club_id, name, description) VALUES (1,2,'Veterans','');

CREATE TABLE members (
    id             INTEGER  PRIMARY KEY AUTOINCREMENT,
    team_id        INTEGER  NOT NULL,
    first_name     TEXT     NOT NULL,
    last_name      TEXT     NOT NULL,
    year_of_birth  INTEGER  NOT NULL,
    portrait_image TEXT     DEFAULT '',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT NULL,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON UPDATE CASCADE
);

CREATE INDEX members_name ON members(last_name, first_name);
CREATE INDEX members_team_id ON members(team_id);

CREATE TRIGGER members_update_timestamp AFTER UPDATE ON members FOR EACH ROW BEGIN
    UPDATE members
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

INSERT INTO members (id, team_id, first_name, last_name, year_of_birth) VALUES
(1,1,'Aleš','Vaupotič',1970);

CREATE VIEW IF NOT EXISTS v_members AS
SELECT
    m.id,
    m.team_id,
    t.name AS team_name,
    m.first_name,
    m.last_name,
    m.year_of_birth,
    m.portrait_image,
    m.created_at,
    m.updated_at
FROM members m
    LEFT JOIN teams t
        ON m.team_id = t.id
    LEFT JOIN clubs c
        ON c.id = t.club_id;
