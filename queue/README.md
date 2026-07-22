# Queue - Redis-backed job queue

A zero-dependency job queue powered by Bun's native `RedisClient`. Jobs are persisted in Redis across restarts, processed by a standalone worker process that can be scaled and deployed independently from the HTTP server.

---

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
| `id`            | string | UUID v4                                        |
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

Connects to Redis. Reads `REDIS_URL` env var; defaults to `redis://localhost:6379`.

```ts
init_queue();
init_queue("redis://user:pass@host:6380");
```

### `enqueue(params)`

Returns the generated job ID (UUID v4).

```ts
const job_id = await enqueue({
	type: "send_email",
	payload: { to: "user@example.com", subject: "Hello", body: "..." },
	queue: "email", // optional, defaults to type
	max_attempts: 5, // optional, defaults to 3
	scheduled_for: new Date(Date.now() + 60_000), // optional, delayed job
});
```

### `start_worker(type, handler, options?)`

Spawns one or more long-lived fibres that block on `BRPOP`. Each dequeued job is passed to `handler`. Errors thrown by the handler are caught, logged, and the job is either retried or sent to the dead-letter set.

```ts
start_worker(
	"send_email",
	async (job) => {
		await send_mail(job.payload);
	},
	{ concurrency: 3 },
);
```

### `reap_orphans(timeout_ms?)`

Scans the `queue:running` set and re-enqueues any job whose `last_run_at` is older than `timeout_ms` (default 5 min). Call once at worker startup to recover jobs orphaned by a previous crash. Returns the number of re-enqueued jobs.

### `get_job(job_id)`

Returns a full `Job` object, or `null` if expired.

### `get_failed_job_ids(queue?, limit?)`

Returns up to `limit` job IDs from the dead-letter set (newest first).

### `queue_length(queue?)`

Number of pending jobs in a queue.

### `close_queue()`

Closes the Redis connection.

---

## Job lifecycle

```
enqueue()
    │
    ▼
  status = "pending"
  LPUSH queue:{name}
    │
    ▼
  BRPOP (worker)
    │
    ├-- job hash missing → skip
    │
    ▼
  status = "running"
  last_run_at = now
  SADD queue:running
    │
    ▼
  handler(job)
    │
    ├-- success ----► status = "completed", SREM queue:running
    │
    └-- error
          │
          ├-- attempts < max_attempts
          │     └--► status = "pending", LPUSH queue:{name} (retry)
          │
          └-- attempts ≥ max_attempts
                └--► status = "failed", ZADD queue:{name}:failed
```

### Delayed jobs

When `scheduled_for` is set, the job ID is stored in a sorted set (`queue:{name}:delayed`) instead of the list. A separate delayed-job worker (not yet implemented) would move eligible jobs from the sorted set into the list when their timestamp arrives.

---

## Running tracking & orphan reaping

When a worker picks up a job, it:

1. Sets `status` to `running` and `last_run_at` to the current timestamp in the job hash.
2. Adds the job ID to the `queue:running` SET.
3. On completion - removes it from the SET.
4. On failure (retry or dead letter) - removes it from the SET.

If the worker process crashes while a job is running, that job ID stays in `queue:running` with `status = "running"`.

The `reap_orphans()` function is designed to be called once at worker startup:

- Reads all members of `queue:running`.
- For each, fetches the job hash and checks `last_run_at`.
- If the job has been running longer than `timeout_ms` (default 5 min), it's re-enqueued (status → `pending`, LPUSH back to its queue, SREM from running set).
- The `attempts` counter is bumped on re-enqueue to prevent infinite reaper loops if the handler keeps crashing.
- Previous error messages are preserved by appending to `error_message`.

**BRPOP gap:** After `BRPOP` removes a job from the list, if the worker crashes before `SADD queue:running`, the job is gone from the list but not tracked in the running set. This is an inherent at-least-once delivery trade-off. A future improvement could use `RPOPLPUSH` or maintain a processing list to close this gap.

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

```ts
import { init_queue, reap_orphans, start_worker } from "$queue/index";
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
```

### package.json scripts

```json
{
	"worker": "bun worker.ts",
	"devw": "conc -n dev,wk -c blue,green \"bun dev\" \"bun worker\""
}
```

---

## Configuration

| Env var     | Default                  | Description      |
| ----------- | ------------------------ | ---------------- |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |

---

## Limitations & future improvements

- **No delayed-job sweeper** - Scheduled jobs sit in the sorted set forever. A periodic worker that `ZRANGEBYSCORE … BYSCORE` and moves due jobs into the list is needed for delayed execution to work.
- **BRPOP orphan gap** - The window between `BRPOP` and `SADD queue:running` can lose a job on crash. Mitigation: startup re-enumeration of processing lists, or switch to `RPOPLPUSH` with a processing queue.
- **No admin UI** - `get_failed_job_ids()`, `queue_length()`, and `get_job()` are exported so a monitoring page can be built.
