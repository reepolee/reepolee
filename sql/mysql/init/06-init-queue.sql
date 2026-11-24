-- SQL-backed job queue store (used when REDIS_URL is unset - see queue/README.md).
-- Columns mirror the queue Job type 1:1. Status transitions are
-- pending -> running -> completed | failed, with the reaper re-queueing stale
-- running rows. scheduled_for > 0 marks a delayed job (0 = immediate); delayed
-- jobs are not claimable until their timestamp arrives, so no sweeper is needed.
DROP TABLE IF EXISTS jobs;

CREATE TABLE IF NOT EXISTS jobs (
    id            VARCHAR(36) NOT NULL COMMENT 'ICU',
    type          VARCHAR(64) NOT NULL,
    queue         VARCHAR(64) NOT NULL COMMENT 'ICU',
    payload       TEXT        NOT NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'ICU',
    attempts      INT(10)     NOT NULL DEFAULT 0,
    max_attempts  INT(10)     NOT NULL DEFAULT 3,
    error_message TEXT        DEFAULT NULL,
    created_at    BIGINT(20)  NOT NULL,
    last_run_at   BIGINT(20)  NOT NULL DEFAULT 0,
    scheduled_for BIGINT(20)  NOT NULL DEFAULT 0,
    expires_at    BIGINT(20)  NOT NULL,
    PRIMARY KEY(id),
    KEY jobs_queue_status_scheduled_created(queue, status, scheduled_for, created_at),
    KEY jobs_status(status),
    KEY jobs_expires_at(expires_at)
);

-- Tiny key/value table for the worker heartbeat (worker PID) - storage-agnostic
-- replacement for the Redis `queue:worker:pid` key.
DROP TABLE IF EXISTS queue_meta;

CREATE TABLE IF NOT EXISTS queue_meta (
    meta_key   VARCHAR(64)  NOT NULL COMMENT 'ICU',
    meta_value VARCHAR(255) NOT NULL DEFAULT '',
    PRIMARY KEY(meta_key)
);
