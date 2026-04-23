# Architecture

## System Scope

XProxy Tester is a continuous proxy observability system. It synchronizes devices from XProxy, tests proxies on a tight interval, records request-level telemetry, runs periodic IP rotation checks, and serves health/metrics and operational APIs.

## Architecture Layers

1. Transport and entry layer
   - `src/main.ts` bootstraps runtime services
   - `src/server.ts` exposes health, metrics, testing control, and analytics endpoints

2. Service orchestration layer
   - `src/services/continuous-proxy-tester.ts`
   - `src/services/ip-rotation.ts`
   - `src/services/speed-test-service.ts`
   - `src/services/daily-aggregation.ts`
   - `src/services/archival.ts`
   - `src/services/duplicate-ip-snapshot.ts`

3. Integration layer
   - external API clients: `src/clients/*`
   - queue adapters: `src/lib/proxy-test-write-queue.ts`, `src/lib/proxy-meta-write-queue.ts`

4. Persistence layer
   - Prisma + MySQL (`prisma/schema.prisma`)

5. Observability layer
   - pino logging (`src/lib/logger.ts`)
   - Prometheus metrics (`src/lib/metrics.ts`)
   - Grafana dashboards and SQL views

## Runtime Relationships

```text
function appStartup():
  startHttpServer()                     # operational endpoints
  initializeDatabaseSchemaAndViews()    # schema prerequisites
  ensurePartitioningSetup()             # retention prerequisites
  startBullMqWorkers()                  # async persistence workers
  startContinuousProxyTesting()         # high-frequency test loop
  startSpeedTestService()               # periodic speed telemetry
  startPeriodicIpRotation()             # scheduled rotation cycles
  startDailyAggregationService()        # daily analytics rollups
  startArchivalService()                # retention cleanup
  startDuplicateIpSnapshotService()     # duplicate-IP diagnostics
```

```text
function continuousTestingCycle():
  devices = refreshDevicesFromXProxy()
  for each device in devices:
    metrics = runProxyTestRequest(device)                    # execute request through proxy
    result = classifyStatusAndMetrics(metrics)               # map to success/failure/error type
    enqueueOk = enqueueWriteJob(device, result)              # queue async persistence
    if enqueueOk:
      processWithBullMqWorker(device, result)                # normal write path
    else:
      writeDirectlyToDatabase(device, result)                # resilience fallback path
    updateProxyStateFields(device, result)                   # proxy metadata and last state
    updateStabilityAndRotationCounters(device, result)       # stability + rotation indicators
```

```text
function periodicRotationCycle():
  cycle = createRotationCycle()
  for each proxy in activeProxies:
    sendRotationCommand(proxy)                               # trigger device rotation
    verification = verifyRotationWithRetries(proxy)          # verify status/IP transition
    persistIpRotation(cycle, proxy, verification)            # persist per-device result
  updateRotationCycleCounters(cycle)                         # persist cycle totals
```

```text
function dailyDataLifecycle():
  aggregateProxyRequests()                                   # compute raw daily aggregates
  upsertDailySummaryRows()                                   # persist rollup rows
  runArchivalAndRetentionCleanup()                           # remove or archive stale data
```

## API Relationships

| Endpoint | Handler | Service/Module | Data Path |
|---|---|---|---|
| `GET /health` | `getHealthStatus` | `src/api/health.ts` | runtime + DB checks |
| `GET /ready` | `getReadiness` | `src/api/health.ts` | readiness checks |
| `GET /live` | `getLiveness` | `src/api/health.ts` | liveness checks |
| `GET /metrics` | `exportPrometheusMetrics` | `src/lib/metrics.ts` | in-memory registry |
| `GET /api/testing/status` | `getTestingStatusHandler` | `src/api/testing.ts` | tester runtime state |
| `POST /api/testing/start` | `startTestingHandler` | `continuous-proxy-tester` | starts loops/services |
| `POST /api/testing/stop` | `stopTestingHandler` | `continuous-proxy-tester` | stops loops/services |
| `GET /api/analytics/problems` | `getProblemsHandler` | `src/api/analytics.ts` | `proxies` + grouped `proxy_requests` |

## Core Data Relationships

- `Proxy` is the root operational entity (`device_id` primary key)
- `ProxyRequest` is high-volume request telemetry (many-to-one to `Proxy`)
- `SpeedTest` is periodic throughput telemetry (many-to-one to `Proxy`)
- `IpRotation` stores per-device rotation attempt data (many-to-one to `Proxy`)
- `RotationCycle` groups rotation attempts for scheduled cycles (one-to-many to `IpRotation`)
- `ProxyRequestsDailySummary` is rollup analytics keyed by `(day, proxy_id)`
- `DuplicateIpSnapshotRow` and `DuplicateIpSnapshotServer` model duplicate-IP group snapshots

## Critical Lifecycle Dependencies

- Worker startup dependency:
  - start queue workers only after DB schema and views are ready
- Graceful shutdown dependency:
  - stop schedulers and loops first
  - stop queue workers second
  - flush pending writes last

## Testing Process

Each active proxy is tested continuously every 5 seconds (configurable via `TEST_INTERVAL_MS`). Each test:

1. Makes HTTP request through proxy to `https://api.ipify.org?format=json` (configurable via `TEST_TARGET_URL`)
2. Measures response time (timeout: 30s, configurable via `REQUEST_TIMEOUT_MS`)
3. Extracts outbound IP from response
4. Compares with expected IP (`device.ip_address`) to detect rotation
5. Stores result in `proxy_requests` table

### Test Success Criteria

Test is **SUCCESS** when:
- HTTP request completes without error
- Valid response received (status 200-299)
- Response body valid JSON with IP information
- Request completes within timeout

**Note:** Success does not require returned IP to match expected IP. IP mismatches are logged but count as successful requests.

### Test Failure Types

- **TIMEOUT**: Request exceeds timeout duration
- **CONNECTION_ERROR**: Unable to establish connection through proxy
- **HTTP_ERROR**: HTTP error response (status >= 400)
- **DNS_ERROR**: DNS resolution failed

All results stored with timestamp, response time, outbound IP, and error details.

## Configuration Domains

- Runtime and testing loop: `RUN_MODE`, `MIN_RUN_HOURS`, `TEST_INTERVAL_MS`, `REQUEST_TIMEOUT_MS`
- Rotation: `IP_ROTATION_*`, `PERIODIC_IP_ROTATION_INTERVAL_MS`
- Reliability and lifecycle: queue/Redis settings, `STARTUP_DAILY_BACKFILL_DAYS`
- Retention: `ENABLE_ARCHIVAL`, `ARCHIVAL_INTERVAL_MS`, `DATA_RETENTION_DAYS`
- Security and API access: `ENCRYPTION_KEY`, `API_SECRET_KEY`, `CORS_ALLOWED_ORIGIN`
