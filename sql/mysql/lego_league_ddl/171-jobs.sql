-- MySQL 8.0+ LEGO League schema
-- Table: jobs

CREATE TABLE IF NOT EXISTS jobs (
    id            VARCHAR(255) NOT NULL,
    type          VARCHAR(255) NOT NULL,
    queue         VARCHAR(255) NOT NULL,
    payload       LONGTEXT     NOT NULL DEFAULT('{}'),
    status        VARCHAR(255) NOT NULL DEFAULT 'pending',
    attempts      INT          NOT NULL DEFAULT 0,
    max_attempts  INT          NOT NULL DEFAULT 3,
    error_message TEXT         DEFAULT NULL,
    created_at    BIGINT       NOT NULL,
    last_run_at   BIGINT       NOT NULL DEFAULT 0,
    scheduled_for BIGINT       NOT NULL DEFAULT 0,
    expires_at    BIGINT       NOT NULL,
    display       VARCHAR(255) GENERATED ALWAYS AS(id) VIRTUAL,
    PRIMARY KEY(id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX jobs_queue_status_scheduled_created ON jobs(queue, status, scheduled_for, created_at);

CREATE INDEX jobs_status ON jobs(status);

CREATE INDEX jobs_expires_at ON jobs(expires_at);
