-- MySQL 8.0+ LEGO League schema
-- Table: emails

CREATE TABLE IF NOT EXISTS emails (
    id                  INT          PRIMARY KEY AUTO_INCREMENT,
    team_id             INT          DEFAULT NULL,
    tournament_id       INT          DEFAULT NULL,
    recipient           VARCHAR(255) NOT NULL,
    subject             VARCHAR(255) NOT NULL,
    body                LONGTEXT     NOT NULL,
    type                VARCHAR(255) NOT NULL DEFAULT 'manual',
    status_id           INT          NOT NULL,
    sent_at             TIMESTAMP    DEFAULT NULL,
    provider_message_id VARCHAR(255) DEFAULT NULL,
    display             VARCHAR(255) GENERATED ALWAYS AS(subject) VIRTUAL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    archived_at         TIMESTAMP    DEFAULT NULL,
    archived_by_user_id INT          DEFAULT NULL,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON UPDATE CASCADE,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON UPDATE CASCADE,
    FOREIGN KEY(status_id) REFERENCES email_statuses(id) ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX emails_team_id ON emails(team_id);

CREATE INDEX emails_tournament_id ON emails(tournament_id);

CREATE INDEX emails_status_id ON emails(status_id);

CREATE INDEX emails_archived_at ON emails(archived_at);
