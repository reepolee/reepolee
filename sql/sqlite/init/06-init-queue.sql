-- SQL-backed job queue store (used when REDIS_URL is unset - see queue/README.md).
-- Columns mirror the queue Job type 1:1. Status transitions are
-- pending -> running -> completed | failed, with the reaper re-queueing stale
-- running rows. scheduled_for > 0 marks a delayed job (0 = immediate); delayed
-- jobs are not claimable until their timestamp arrives, so no sweeper is needed.

DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
    id            TEXT    NOT NULL,
    type          TEXT    NOT NULL,
    queue         TEXT    NOT NULL,
    payload       TEXT    NOT NULL DEFAULT '{}',
    status        TEXT    NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 3,
    error_message TEXT    DEFAULT NULL,
    created_at    INTEGER NOT NULL,
    last_run_at   INTEGER NOT NULL DEFAULT 0,
    scheduled_for INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER NOT NULL,
    display       TEXT    GENERATED ALWAYS AS(id) VIRTUAL,
    PRIMARY KEY(id)
);

-- Claim path: WHERE queue = ? AND status = 'pending'
--              AND (scheduled_for = 0 OR scheduled_for <= ?) ORDER BY created_at
CREATE INDEX jobs_queue_status_scheduled_created ON jobs(queue, status, scheduled_for, created_at);

-- Reaper path: WHERE status = 'running' AND last_run_at < ?
CREATE INDEX jobs_status ON jobs(status);

-- TTL sweep: WHERE expires_at <= ?
CREATE INDEX jobs_expires_at ON jobs(expires_at);

-- Tiny key/value table for the worker heartbeat (worker PID) - storage-agnostic
-- replacement for the Redis `queue:worker:pid` key.
DROP TABLE IF EXISTS queue_meta;

CREATE TABLE queue_meta (
    meta_key   TEXT NOT NULL,
    meta_value TEXT NOT NULL DEFAULT '',
    display    TEXT GENERATED ALWAYS AS(meta_key) VIRTUAL,
    PRIMARY KEY(meta_key)
);
