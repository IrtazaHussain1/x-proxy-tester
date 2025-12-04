# Requirements Verification

This document verifies that all requirements from the original ticket are implemented.

## ✅ 1. Fetch Proxy List from XProxy Portal

**Requirement**: Fetch the full list of available proxies from the XProxy Portal API

**Implementation**:
- ✅ `src/api/devices.ts` - Fetches devices from XProxy Portal API
- ✅ `src/helpers/devices.ts` - Handles pagination (50 per page) and fetches all devices
- ✅ Uses `XPROXY_API_URL` and `XPROXY_API_TOKEN` from environment variables
- ✅ API endpoint: `{XPROXY_API_URL}/devices`

**Code Reference**: 
- `src/api/devices.ts` - `getDevices()` and `getDevicesWithMetadata()`
- `src/helpers/devices.ts` - `fetchAllDevices()` handles pagination

---

## ✅ 2. Store Proxy List Locally

**Requirement**: Store proxy list locally (in DB or file) for ongoing testing

**Implementation**:
- ✅ Proxies stored in MySQL database (`proxies` table)
- ✅ Each proxy record includes: `portal_proxy_id`, `name`, `host`, `port`, `username`, `password`, etc.
- ✅ Proxies are created/updated in `saveProxyTestToDatabase()` function

**Code Reference**: 
- `prisma/schema.prisma` - `Proxy` model
- `src/services/continuous-proxy-tester.ts` - `saveProxyTestToDatabase()` (lines 93-243)

---

## ✅ 3. Refresh Proxy List Every 6 Hours

**Requirement**: Refresh proxy list every 6 hours

**Implementation**:
- ✅ `PROXY_REFRESH_INTERVAL_MS = 21600000` (6 hours = 6 * 60 * 60 * 1000 ms)
- ✅ Device list refresh happens in `refreshDeviceTesters()` function
- ✅ Refresh interval is set in `startContinuousTesting()` using `setInterval()`
- ✅ Cache is checked in `getDevicesWithRefresh()` - refreshes if cache is older than 6 hours

**Code Reference**: 
- `src/config/index.ts` - Line 77: `PROXY_REFRESH_INTERVAL_MS`
- `src/services/continuous-proxy-tester.ts` - Lines 344-366, 418-420

---

## ✅ 4. Send HTTP Request Every 5 Seconds

**Requirement**: For every proxy, send an HTTP request every 5 seconds

**Implementation**:
- ✅ `TEST_INTERVAL_MS = 5000` (5 seconds)
- ✅ Each device has its own independent 5-second interval
- ✅ Interval is measured from END of one request to START of next request
- ✅ Implemented in `startDeviceTesting()` using recursive `setTimeout()`

**Code Reference**: 
- `src/config/index.ts` - Line 73: `TEST_INTERVAL_MS = 5000`
- `src/services/continuous-proxy-tester.ts` - Lines 338-390: `startDeviceTesting()`

---

## ✅ 5. Fetch Simple Website

**Requirement**: Fetch a simple website (e.g., api.ipify.org)

**Implementation**:
- ✅ Default target URL: `https://api.ipify.org?format=json`
- ✅ Configurable via `TEST_TARGET_URL` environment variable
- ✅ Request made through proxy using `undici` with `ProxyAgent`

**Code Reference**: 
- `src/config/index.ts` - Line 81: `TEST_TARGET_URL`
- `src/clients/proxyClient.ts` - `requestThroughProxy()` function

---

## ✅ 6. Validate Request Success/Failure, Response Time, Returned IP

**Requirement**: Validate:
- Request success/failure
- Response time
- Returned IP (detect if rotation occurred)

**Implementation**:
- ✅ `success`: Boolean field in `ProxyMetrics`
- ✅ `responseTimeMs`: Response time in milliseconds
- ✅ `outboundIp`: Extracted from response body (supports JSON and text formats)
- ✅ All validated and stored in database

**Code Reference**: 
- `src/clients/proxyClient.ts` - Lines 117-147: IP extraction and metrics collection
- `src/services/continuous-proxy-tester.ts` - Lines 160-175: Database storage

---

## ✅ 7. Log Each Test Event

**Requirement**: Log each test event

**Implementation**:
- ✅ Every test is logged to `proxy_requests` table
- ✅ Includes all metrics: timestamp, status, response time, IP, errors, etc.
- ✅ Also logged to console using Pino logger with structured logging

**Code Reference**: 
- `src/services/continuous-proxy-tester.ts` - Lines 160-175: `prisma.proxyRequest.create()`
- `src/helpers/test-proxy.ts` - Logging in `testProxyWithStats()`

---

## ✅ 8. Use 30-Second Timeout

**Requirement**: Use a 30-second timeout for all requests

**Implementation**:
- ✅ `REQUEST_TIMEOUT_MS = 30000` (30 seconds)
- ✅ Applied to both `headersTimeout` and `bodyTimeout` in undici request
- ✅ Configurable via environment variable

**Code Reference**: 
- `src/config/index.ts` - Line 74: `REQUEST_TIMEOUT_MS = 30000`
- `src/clients/proxyClient.ts` - Lines 136-137: `headersTimeout` and `bodyTimeout`

---

## ✅ 9. Record Outbound IP

**Requirement**: Every request must record the outbound IP

**Implementation**:
- ✅ `outboundIp` field in `ProxyRequest` model
- ✅ Extracted from response body (supports multiple formats: JSON `ip`, `origin`, `query`, or text regex)
- ✅ Stored in database for every request

**Code Reference**: 
- `prisma/schema.prisma` - Line 49: `outboundIp` field
- `src/clients/proxyClient.ts` - Lines 117-135: IP extraction logic

---

## ✅ 10. Detect When Proxy Rotates IPs

**Requirement**: Detect when the proxy rotates IPs

**Implementation**:
- ✅ Compares current `outboundIp` with previous `lastIp` from database
- ✅ Sets `ipChanged` flag to `true` when IP changes
- ✅ Increments `rotationCount` when rotation detected
- ✅ Records `lastRotationAt` timestamp

**Code Reference**: 
- `src/services/continuous-proxy-tester.ts` - Lines 145-189: Rotation detection logic

---

## ✅ 11. Flag Proxy if IP Doesn't Change After 10 Attempts

**Requirement**: If IP does NOT change after X rotations (default: 10 attempts), flag the proxy

**Implementation**:
- ✅ `ROTATION_THRESHOLD = 10` (configurable via environment variable)
- ✅ Tracks `sameIpCount` - increments when IP stays the same
- ✅ Sets `rotationStatus = 'NoRotation'` when `sameIpCount >= ROTATION_THRESHOLD`
- ✅ Resets to `'OK'` when rotation is detected

**Code Reference**: 
- `src/config/index.ts` - Line 75: `ROTATION_THRESHOLD = 10`
- `src/services/continuous-proxy-tester.ts` - Lines 183-186: Flagging logic

---

## ✅ 12. Stability: 10 Minutes in 1-Hour Window

**Requirement**: A proxy is unstable if it is down more than 10 minutes within any 1-hour window

**Implementation**:
- ✅ `UNSTABLE_HOURLY_THRESHOLD_MS = 10 * 60 * 1000` (10 minutes)
- ✅ Checks all 1-hour sliding windows in the last 2 hours
- ✅ Slides window by 10-minute increments
- ✅ Calculates downtime as: `failed_requests_count × TEST_INTERVAL_MS`
- ✅ Flags as `UnstableHourly` if any window exceeds 10 minutes

**Code Reference**: 
- `src/services/stability-calculator.ts` - Lines 24, 43-99: `checkHourlyStability()`

---

## ✅ 13. Stability: 1 Hour in 24-Hour Window

**Requirement**: A proxy is unstable if it is down more than 1 hour within a 24-hour window

**Implementation**:
- ✅ `UNSTABLE_DAILY_THRESHOLD_MS = 60 * 60 * 1000` (1 hour)
- ✅ Checks all 24-hour sliding windows in the last 2 days
- ✅ Slides window by 1-hour increments
- ✅ Calculates downtime as: `failed_requests_count × TEST_INTERVAL_MS`
- ✅ Flags as `UnstableDaily` if any window exceeds 1 hour
- ✅ Daily instability takes precedence over hourly

**Code Reference**: 
- `src/services/stability-calculator.ts` - Lines 25, 101-151: `checkDailyStability()`

---

## ✅ 14. Classify Proxies as Stable/UnstableHourly/UnstableDaily

**Requirement**: Automatically classify each proxy as:
- Stable
- Unstable (Hourly)
- Unstable (Daily)

**Implementation**:
- ✅ `stabilityStatus` field in `Proxy` model
- ✅ Values: `'Stable'`, `'UnstableHourly'`, `'UnstableDaily'`, `'Unknown'`
- ✅ Calculated in `calculateProxyStability()` function
- ✅ Runs automatically every 10 minutes via `startStabilityCalculation()`

**Code Reference**: 
- `prisma/schema.prisma` - Line 23: `stabilityStatus` field
- `src/services/stability-calculator.ts` - Lines 153-194: `calculateProxyStability()`

---

## ✅ 15. Run Continuously for 72 Hours (or Indefinitely)

**Requirement**: Tests must run continuously for at least 72 hours. Include a flag to continue indefinitely.

**Implementation**:
- ✅ `MIN_RUN_HOURS = 72` (default, configurable via environment variable)
- ✅ `RUN_MODE` flag: `'infinite'` or `'fixed'`
  - **Infinite mode**: Runs indefinitely until manually stopped (SIGINT/SIGTERM)
  - **Fixed mode**: Runs for at least `MIN_RUN_HOURS`, then auto-shuts down
- ✅ In fixed mode, shutdown requests (SIGINT/SIGTERM) are blocked until minimum runtime is met
- ✅ Runtime monitor checks every hour (configurable via `MONITOR_CHECK_INTERVAL_MS`)
- ✅ Graceful shutdown on SIGINT/SIGTERM signals

**Code Reference**: 
- `src/config/index.ts` - Lines 89-94, 135-139: Runtime configuration
- `main.ts` - Lines 12-150: Runtime management and shutdown logic
- `src/services/continuous-proxy-tester.ts` - `startContinuousTesting()` runs continuously

---

## ✅ 16. Data Logging Requirements

**Requirement**: Log every request, including:
- Proxy ID
- Timestamp
- Response status (success, failure, timeout)
- Response time (ms)
- Outbound IP detected
- Whether IP changed compared to prior request
- Error type (connection refused, timeout, DNS failure, etc.)

**Implementation**:
- ✅ **Proxy ID**: `proxyId` field (foreign key to `proxies.id`)
- ✅ **Timestamp**: `timestamp` field (DateTime, indexed)
- ✅ **Response status**: `status` field (`SUCCESS`, `TIMEOUT`, `CONNECTION_ERROR`, `HTTP_ERROR`, `DNS_ERROR`, `OTHER`)
- ✅ **Response time**: `responseTimeMs` field (Int, in milliseconds)
- ✅ **Outbound IP**: `outboundIp` field (String, indexed)
- ✅ **IP changed**: `ipChanged` field (Boolean, indexed)
- ✅ **Error type**: `errorType` field (`TIMEOUT`, `CONNECTION_REFUSED`, `DNS_ERROR`, `HTTP_ERROR`, `TLS_ERROR`, `CONNECTION_RESET`, `OTHER`)
- ✅ **Error message**: `errorMessage` field (detailed error message)
- ✅ **Additional fields**: `expectedIp`, `httpStatusCode`, `targetUrl`

**Code Reference**: 
- `prisma/schema.prisma` - Lines 40-63: `ProxyRequest` model
- `src/services/continuous-proxy-tester.ts` - Lines 160-175: Database insertion

---

## ✅ 17. Store in Database

**Requirement**: Store in DB (for future dashboard)

**Implementation**:
- ✅ All data stored in MySQL database
- ✅ Two main tables: `proxies` and `proxy_requests`
- ✅ Proper indexes for efficient querying
- ✅ Foreign key relationships for data integrity
- ✅ Ready for dashboard implementation

**Code Reference**: 
- `prisma/schema.prisma` - Complete database schema
- All indexes defined for optimal query performance

---

## Summary

**All 17 requirements are fully implemented and verified.**

The system:
- ✅ Fetches proxies from XProxy Portal API
- ✅ Stores proxies in MySQL database
- ✅ Refreshes proxy list every 6 hours
- ✅ Tests each proxy every 5 seconds
- ✅ Uses 30-second timeout
- ✅ Detects IP rotation and flags non-rotating proxies
- ✅ Calculates stability (hourly and daily windows)
- ✅ Logs all required data to database
- ✅ Runs continuously until manually stopped

**Status**: ✅ **ALL REQUIREMENTS MET**

