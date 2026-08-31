-- SQL-backed job queue store (used when REDIS_URL is unset - see queue/README.md).
-- Columns mirror the queue Job type 1:1. Status transitions are
-- pending -> running -> completed | failed, with the reaper re-queueing stale
-- running rows. scheduled_for > 0 marks a delayed job (0 = immediate); delayed
-- jobs are not claimable until their timestamp arrives, so no sweeper is needed.

DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
    id            VARCHAR(36)  NOT NULL COMMENT 'ICU',
    type          VARCHAR(64)  NOT NULL COMMENT '',
    queue         VARCHAR(64)  NOT NULL COMMENT 'ICU',
    payload       TEXT         NOT NULL COMMENT '',
    status        VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'ICU',
    attempts      INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '',
    max_attempts  INT UNSIGNED NOT NULL DEFAULT 3 COMMENT '',
    error_message TEXT         NULL COMMENT '',
    created_at    BIGINT       NOT NULL COMMENT '',
    last_run_at   BIGINT       NOT NULL DEFAULT 0 COMMENT '',
    scheduled_for BIGINT       NOT NULL DEFAULT 0 COMMENT '',
    expires_at    BIGINT       NOT NULL COMMENT '',
    display       VARCHAR(36)  GENERATED ALWAYS AS (id) VIRTUAL,
    PRIMARY KEY (id),
    -- Claim path: WHERE queue = ? AND status = 'pending'
    --              AND (scheduled_for = 0 OR scheduled_for <= ?) ORDER BY created_at
    INDEX jobs_queue_status_scheduled_created (queue, status, scheduled_for, created_at),
    -- Reaper path: WHERE status = 'running' AND last_run_at < ?
    INDEX jobs_status (status),
    -- TTL sweep: WHERE expires_at <= ?
    INDEX jobs_expires_at (expires_at)
) COMMENT '';

-- Tiny key/value table for the worker heartbeat (worker PID) - storage-agnostic
-- replacement for the Redis `queue:worker:pid` key.
DROP TABLE IF EXISTS queue_meta;

CREATE TABLE queue_meta (
    meta_key   VARCHAR(64)  NOT NULL COMMENT 'ICU',
    meta_value VARCHAR(255) NOT NULL DEFAULT '' COMMENT '',
    display    VARCHAR(64)  GENERATED ALWAYS AS (meta_key) VIRTUAL,
    PRIMARY KEY (meta_key)
) COMMENT '';
