# Operations Runbook

## Purpose

This runbook defines startup, deployment, health checks, rollback, and incident handling for XProxy Tester.

## Startup and Shutdown

### Startup sequence

1. Start HTTP server
2. Wait for DB availability
3. Initialize schema/view/partition prerequisites
4. Start queue workers
5. Start runtime services (testing, rotation, speed tests, aggregation, archival, duplicate-IP snapshots)

### Shutdown sequence

1. Stop schedulers and service loops
2. Stop queue workers
3. Flush pending writes
4. Exit

This order prevents lost writes during shutdown.

### Startup pseudocode

```text
function startup():
  startHttpServer()             # expose health/metrics/control endpoints
  waitForDatabase()             # block boot until DB can accept connections
  initializeSchemaAndViews()    # ensure required tables/columns/views exist
  ensurePartitioning()          # ensure retention partition setup is available
  startQueueWorkers()           # enable async write consumers
  startContinuousTesting()      # begin per-device proxy test loops
  startSpeedTests()             # begin periodic bandwidth/latency checks
  startPeriodicIpRotation()     # begin scheduled rotation cycles
  startDailyAggregation()       # schedule daily rollup jobs
  startArchival()               # schedule retention/cleanup routines
  startDuplicateIpSnapshots()   # schedule duplicate-IP capture jobs
```

### Shutdown pseudocode

```text
function shutdown():
  stopSchedulersAndLoops()      # prevent new jobs from being created
  stopQueueWorkers()            # stop consuming queued jobs
  flushPendingWrites()          # drain buffered writes to storage
  exitProcess()                 # terminate process cleanly
```

### Function intent map

| Function | Purpose |
|---|---|
| `startHttpServer` | Opens operational HTTP endpoints used by monitoring and control. |
| `waitForDatabase` | Ensures DB dependency is ready before starting write-producing services. |
| `initializeSchemaAndViews` | Prepares schema-level prerequisites required by runtime services. |
| `ensurePartitioning` | Confirms partition/retention structure expected by data lifecycle jobs. |
| `startQueueWorkers` | Starts BullMQ consumers used for async persistence. |
| `startContinuousTesting` | Starts continuous proxy request execution and result generation. |
| `startSpeedTests` | Starts periodic speed/latency test loop. |
| `startPeriodicIpRotation` | Starts scheduled rotation command and verification flow. |
| `startDailyAggregation` | Schedules daily rollup generation for analytics reads. |
| `startArchival` | Schedules retention cleanup for old data. |
| `startDuplicateIpSnapshots` | Captures periodic shared-IP snapshots for diagnostics. |
| `stopSchedulersAndLoops` | Stops new runtime work from being enqueued. |
| `stopQueueWorkers` | Stops active queue consumers before final drain. |
| `flushPendingWrites` | Forces pending buffered writes to complete before exit. |
| `exitProcess` | Completes shutdown by terminating the process. |

## Deployment

### Standard deployment

```bash
npm install
npm run build
npm start
```

### Docker deployment

```bash
docker-compose up -d --build
```

## Core Runtime Checks

### HTTP checks

GET /health
GET /ready
GET /live
GET /metrics

`GET /health` now includes a `scheduler` block with registered job status, schedule metadata, `currently_running`, `last_run_started_at`, `last_run_ended_at`, `last_run_success_at`, and truncated `last_error` fields for cron, interval, and timeout jobs managed by `src/services/cron.service.ts`.

### Management API checks

GET /api/testing/status
POST /api/testing/start
POST /api/testing/stop

### Analytics check

GET /api/analytics/problems

## High-Impact Environment Variables

### Security

| Variable | Description |
|---|---|
| `ENCRYPTION_KEY` | 64-character hex key used to encrypt sensitive proxy credentials before they are persisted. |
| `API_SECRET_KEY` | Bearer token used to protect management endpoints (`POST /api/testing/start`, `POST /api/testing/stop`). |
| `CORS_ALLOWED_ORIGIN` | Allowed browser origin for CORS response headers on HTTP endpoints. |
| `REDIS_PASSWORD` | Password used by Redis/BullMQ connections for queue security. |

### Runtime behavior

| Variable | Description |
|---|---|
| `RUN_MODE` | Runtime mode (`infinite` or `fixed`) controlling whether the process runs continuously or enforces minimum runtime. |
| `MIN_RUN_HOURS` | Minimum process runtime in hours when `RUN_MODE=fixed`. |
| `TEST_INTERVAL_MS` | Interval between continuous proxy tests for each active device. |
| `REQUEST_TIMEOUT_MS` | Timeout for each outbound proxy test request. |

### Rotation behavior

| Variable | Description |
|---|---|
| `IP_ROTATION_ENABLED` | Global switch to enable or disable periodic IP rotation services. |
| `PERIODIC_IP_ROTATION_INTERVAL_MS` | Interval for scheduled periodic rotation cycles. |
| `IP_ROTATION_WAIT_AFTER_ROTATION_MS` | Wait time after a rotation command before verification checks begin. |

### Aggregation and retention

| Variable | Description |
|---|---|
| `ENABLE_DAILY_AGGREGATION_ON_START` | Enables or disables daily aggregation scheduler startup with the app process. |
| `STARTUP_DAILY_BACKFILL_DAYS` | Number of recent days to backfill on startup for missing daily summaries. |
| `ENABLE_ARCHIVAL` | Enables or disables periodic archival and retention routines. |
| `ARCHIVAL_INTERVAL_MS` | Interval between archival routine runs. |
| `DATA_RETENTION_DAYS` | Retention window (in days) used by archival cleanup logic. |

## Incident Playbooks

### Incident triage pseudocode

```text
function handleIncident(type):
  if type == "redis":
    restoreRedis()
    checkMetricsAndGrafanaRecovery()
    return

  if type == "db-pressure":
    reduceBackgroundLoad()
    checkMetricsAndGrafanaRecovery()
    return

  if type == "rotation-failures":
    inspectRotationCommandAndVerificationLogs()
    checkRotationDashboards()
    return
```

### Redis unavailable

Symptoms:
- queue enqueue failures
- warnings around Redis connectivity

Behavior:
- service falls back to direct DB writes for test persistence

Actions:
1. restore Redis
2. inspect app logs for sustained fallback mode
3. confirm `GET /metrics` and Grafana ingestion panels recover to normal

### Database pressure / slow queries

Symptoms:
- delayed writes
- slow health/readiness
- delayed aggregation

Actions:
1. inspect infrastructure metrics and application logs for DB latency or timeout spikes
2. reduce optional background load temporarily:
   - disable startup backfill (`STARTUP_DAILY_BACKFILL_DAYS=0`)
   - increase test interval temporarily
3. verify queue drain and ingestion recovery using `/metrics` and dashboard trends

### Rotation verification failures

Symptoms:
- repeated failed rotations
- high error rates in `ip_rotations`

Actions:
1. validate device API availability
2. inspect command response payloads
3. check rotation dashboards and application logs for status transition issues (`status_before/after`, `ws_status_before/after`)

## Rollback

### Application rollback

1. deploy previous application version
2. keep existing schema (backward-compatible paths are expected)
3. re-run health checks and verify `/metrics` + dashboards are stable

### Config rollback

1. restore previous `.env` values
2. restart service
3. verify endpoints and DB write flow

## Source of Truth

- Architecture: `docs/ARCHITECTURE.md`
- Entry documentation: `README.md`
