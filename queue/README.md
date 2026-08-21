# Queue - background job queue

A zero-dependency job queue. Jobs are persisted across restarts, processed by a
standalone worker process that can be scaled and deployed independently from
the HTTP server.

The store is selected by config, the same way the rate limiter and session
stores are: **Redis when it is enabled (`REDIS_ENABLED=true` and a real
`REDIS_URL`), SQL otherwise**. No Redis means no extra service - the SQL
database (SQLite or MySQL) backs the queue, so it works out of the box on any
platform Bun runs on (including Windows, where Redis has no native build).

Correctness is identical across stores (at-least-once delivery, exactly one
worker claims a given job, delayed jobs run at or after `scheduled_for`);
throughput differs - Redis `BRPOP` wakes instantly, the SQL store polls.
Email and translation batches are latency-insensitive, so the difference does
not matter for the jobs this template ships.

---

## Store selection

| `REDIS_ENABLED`    | `REDIS_URL` | Store  | Notes                                                    |
| ------------------ | ----------- | ------ | -------------------------------------------------------- |
| `true` / `on`      | set         | Redis  | Explicitly enabled.                                      |
| anything else      | set         | SQL    | URL alone no longer enables Redis.                       |
| any                | unset       | SQL    | `jobs` + `queue_meta` tables in the configured database. |

There is no in-flight job migration between stores. Switching backends is a
deliberate act: drain the old queue first, then switch and restart.

## SQL data layout

`sql/{mysql,sqlite}/init/06-init-queue.sql` ships two tables:

- `jobs` - one row per job. Columns mirror the `Job` type: `id` (UUID v7 PK),
  `type`, `queue`, `payload` (JSON text), `status`, `attempts`,
  `max_attempts`, `error_message`, `created_at`, `last_run_at`,
  `scheduled_for`, plus `expires_at` for the 24 h TTL equivalent.
  `scheduled_for` > 0 marks a delayed job; delayed jobs are not claimable
  until their timestamp arrives, so no sweeper is needed.
- `queue_meta` - tiny key/value table holding the worker PID heartbeat.

## Redis data layout

```
job:{id}                     HASH    - full job metadata (24 h TTL)
queue:{name}                 LIST    - pending job IDs
queue:{name}:delayed         ZSET    - scheduled job IDs (score = target timestamp ms)
queue:{name}:failed          ZSET    - permanently failed job IDs (score = timestamp ms)
queue:running                SET     - job IDs currently being processed (for orphan reaping)
```

Every job hash stores these fields:

| Field           | Type   | Description                                    |
| --------------- | ------ | ---------------------------------------------- |
| `id`            | string | UUID v7                                        |
| `type`          | string | Job type identifier (e.g. `send_email`)        |
| `queue`         | string | Queue name (defaults to the type)              |
| `payload`       | JSON   | Handler-specific data                          |
| `status`        | string | `pending` → `running` → `completed` / `failed` |
| `attempts`      | number | How many times execution has been tried        |
| `max_attempts`  | number | Max retries before dead letter (default 3)     |
| `error_message` | string | Last error or reaper note                      |
| `created_at`    | number | Unix timestamp ms                              |
| `last_run_at`   | number | When a worker last picked it up                |
| `scheduled_for` | number | 0 = immediate, > 0 = delayed timestamp ms      |

---

## Public API

### `init_queue(url?)`

Resolves the queue store. Uses Redis when it is available (`REDIS_ENABLED=true`
and a real `REDIS_URL`); the optional `url` argument forces Redis regardless.
Otherwise uses the SQL store, which is always available.

```ts
init_queue();
init_queue("redis://user:pass@host:6380");
```

### `enqueue(params)`

Returns the generated job ID (UUID v7).

```ts
const job_id = await enqueue({
	type: "send_email",
	payload: { to: "user@example.com", subject: "Hello", body: "..." },
	queue: "email", // optional, defaults to type
	max_attempts: 5, // optional, defaults to 3
	scheduled_for: new Temporal.Instant(...), // optional, delayed job
});
```

### `start_worker(type, handler, options?)`

Registers a handler for one job type. Registration is declarative: the
consume loops are spawned later by `start_workers()`. Re-registering a type
(a hot reload re-runs `worker.ts`, which re-registers every handler) replaces
the previous spec rather than duplicating it. Each dequeued job is passed to
`handler`; errors are caught, logged, and the job is either retried or
dead-lettered per `max_attempts`.

```ts
start_worker(
	"send_email",
	async (job) => {
		await send_mail(job.payload);
	},
	{ concurrency: 3 },
);
```

Options:

- `concurrency` - number of parallel fibres (default 1).
- `poll_interval_ms` - how long the SQL store waits between claims when a
  queue is empty (default 500). Ignored by the Redis store, which blocks on
  a bounded 1 s `BRPOP`. For SQLite, keep concurrency low - SQLite serializes
  writers.

### `start_workers()`

Starts the consume loop for every registered handler. **Idempotent** - a
second call while running is a no-op, so a double invocation from a hot
reload cannot double-spawn fibres.

### `stop_workers(timeout_ms?)`

Stops every worker: no new jobs are claimed, in-flight handlers get to
finish (the job is `completed` before the drain returns), then resolves.
Bounded by `timeout_ms` (default 30 000) - a wedged handler must not block a
deploy forever; on timeout the still-busy queues are logged and it returns
anyway (the reaper recovers those jobs later).

### `worker_state()`

`"running" | "draining" | "stopped"` - the current lifecycle state.

Stopping is one code path for every trigger: SIGINT/SIGTERM, deploy, `--hot`
file edit, or an operator pause. The lifecycle (controller + fibres) lives on
`globalThis`, so a `bun --hot` re-evaluation sees the previous instance's
fibres and drains them before starting fresh - exactly one set of fibres is
ever consuming. `worker.ts` handles the signals:

```ts
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
// shutdown(): log, clear the heartbeat interval, await stop_workers(),
// close_queue(), exit. A second signal mid-drain hard-exits.
```

### `set_worker_paused(paused)` / `is_worker_paused()`

Pause or resume the worker. The flag lives in the **store** (not process
memory) because the server and worker are separate processes: the admin UI
sets it, and it survives a worker restart - which is what an operator wants
when they paused because a downstream service is down. A paused worker polls
without claiming; it does not exit.

### `reap_orphans(timeout_ms?)`

Re-enqueues any job stuck in `running` whose `last_run_at` is older than
`timeout_ms` (default 5 min). Call once at worker startup to recover jobs
orphaned by a previous crash. Returns the number of re-enqueued jobs.

### `get_job(job_id)`

Returns a full `Job` object, or `null` if expired.

### `get_failed_job_ids(queue?, limit?)`

Returns up to `limit` job IDs from the dead-letter set (newest first).

### `get_pending_job_ids(queue?, limit?)`

Returns up to `limit` pending job IDs for a queue (newest first).

### `queue_length(queue?)`

Number of pending jobs in a queue.

### `retry_job(job_id)`

Resets a failed job to `pending` so a worker picks it up again. Returns false
if the job doesn't exist (or, on the SQL store, isn't failed).

### `delete_job(job_id)`

Deletes a job entirely, in any status (failed, pending, running, completed).
Returns false if the job doesn't exist. Backs the per-job delete action in
the `/system/queues` admin UI.

### `set_worker_heartbeat()` / `is_worker_alive()` / `get_worker_state()`

Records the worker PID (and its lifecycle state) in the store and verifies a
worker process is alive (reads the PID, checks it with `kill -0`).
`get_worker_state()` returns the last recorded lifecycle state so the admin
UI can distinguish running / draining / stopped / dead. Only meaningful when
worker and server share a host - already true for Redis in practice, and
unconditionally true for the SQL store.

### `clear_queue_*` / `clear_all_queues()`

Admin clearing helpers (pending / failed / delayed / all). Back the
`/system/queues` admin UI.

### `close_queue()`

Closes the store connection (no-op for SQL - the DB connection is owned by
`$config/db`).

---

## Job lifecycle

```
enqueue()
    │
    ▼
  status = "pending"
    │
    ├-- SQL: row in jobs, claimable when scheduled_for ≤ now
    │
    └-- Redis: LPUSH queue:{name} (or ZADD delayed)
    │
    ▼
  claim (atomic - SQL UPDATE..RETURNING / SELECT..FOR UPDATE SKIP LOCKED,
         Redis BRPOP + HSET running + SADD queue:running)
    │
    ├-- success ----► status = "completed"
    │
    └-- error
          │
          ├-- attempts < max_attempts
          │     └--► status = "pending" (retry)
          │
          └-- attempts ≥ max_attempts
                └--► status = "failed" (dead letter)
```### Delayed jobs

`enqueue({ scheduled_for })` writes a delayed job. On the SQL store it is the
same row - the claim query filters on `scheduled_for`, so the job becomes
claimable when its timestamp arrives (no sweeper needed). On Redis it lives
in the delayed ZSET, which is written but not yet drained - the pre-existing
Redis limitation (no scheduled-job sweeper); use the SQL store for delayed
jobs until that lands.

## Orphan reaping

The atomic claim means a job is always exactly one of `pending` / `running` /
`completed` / `failed` - there is no window where it is "removed from the
queue but not tracked", so a crash mid-processing leaves a `running` row that
`reap_orphans()` finds and re-enqueues. `attempts` is bumped on re-enqueue so
a handler that keeps crashing is eventually dead-lettered instead of looping
forever.

---

## Usage

### Server - enqueue only

```ts
import { init_queue, enqueue } from "$queue/index";

init_queue();

// in a route handler:
const job_id = await enqueue({ type: "send_email", payload: { to, subject, body } });
```

### Worker - process jobs

Job handlers are **not** all written in `worker.ts`. Handlers for a resource
live next to it in `apps/main/<resource>/workers.ts` and `worker.ts` imports the
array and loops over it - see `.agents/PLAN_worker_registration.md`. A
`workers.ts` must never import its sibling `index.ts` (that drags the server's
render/i18n/CRUD chain into the worker process). Handlers that are not
resource-scoped (email, translations, image variants) live in `worker.ts`'s
`core_workers` array.

```ts
import { init_queue, reap_orphans, start_worker, start_workers } from "$queue/index";
import { send_mail } from "$lib/smtp";

init_queue();

// Recover orphaned jobs from a previous crash
const reaped = await reap_orphans();
if (reaped > 0) {
	console.log(`Re-enqueued ${reaped} orphan(s)`);
}

start_worker(
	"send_email",
	async (job) => {
		await send_mail(job.payload);
	},
	{ concurrency: 1 },
);

// Spawn every registered consume loop. SIGINT/SIGTERM drain via worker.ts.
await start_workers();
```

### Registered job types

| Type | Producer | Handler |
| --- | --- | --- |
| `send_email` | invite flow (`/invite`) | `core_workers` |
| `translate_batch` | `bun reeman sync-translations --translate` | `core_workers` |
| `translate_record` | generated CRUD `.../generate-locale` routes | `core_workers` |
| `image_variants` | image upload pipeline | `core_workers` |
| `reeqa_suite_run` | ReeQA suite / video-E2E start | `apps/reeqa/workers.ts` |
| `reeqa_visual_run` | ReeQA visual start | `apps/reeqa/workers.ts` |
| `reeqa_cancel` | ReeQA cancel | `apps/reeqa/workers.ts` |

At startup the worker logs the registered types and **warns about any queue
with pending jobs but no registered handler** - the `type` string is the only
contract between `enqueue()` and the handler, so a typo would otherwise leave
jobs pending forever with no error anywhere.

### package.json scripts

```json
{
	"dev": "bun scripts/dev_run.ts --app",
	"dev:worker": "bun scripts/dev_run.ts --app --worker",
	"dev:all": "bun scripts/dev_run.ts --app --reeman --reeqa --worker",
	"worker": "bun worker.ts"
}
```

`scripts/dev_run.ts` is a small Bun-native orchestrator: it always builds CSS
and starts `bun --hot server.ts --dev`. The queue worker is **opt-in** - it
runs only when `--worker` is passed (`dev:worker`, `dev:all`, or a bare
`--worker`), so `dev` runs the app alone. Output from each child is streamed
with a `[dev]`/`[wk]` prefix, and SIGINT/SIGTERM are forwarded to the children -
no external process manager needed.

---

## Configuration

| Env var         | Default | Description                                                    |
| --------------- | ------- | -------------------------------------------------------------- |
| `REDIS_ENABLED` | unset   | Must be `true`/`on` for the queue to use Redis.                |
| `REDIS_URL`     | unset   | Redis connection URL; only read when `REDIS_ENABLED=true`.     |

---

## Maintenance

- **24 h TTL** - Redis expires job hashes natively. The SQL store sweeps
  expired rows via `cleanup_expired_jobs()`, scheduled hourly by
  `lib/bootstrap.ts` (skipped when Redis backs the queue).
- **Admin UI** - `/system/queues` (`apps/reeman/queues/index.ts`)    shows
  pending/failed jobs, worker liveness and lifecycle state against either
  store, offers a pause/resume toggle (`POST /system/queues/pause`), and a
  per-job delete for failed jobs (`POST /system/queues/delete`).
