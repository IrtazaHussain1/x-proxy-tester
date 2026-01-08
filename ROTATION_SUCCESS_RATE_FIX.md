# Periodic Rotation Success Rate Fix

## Problem

When periodic IP rotation is enabled, the 2-4 second verification window causes temporary request failures that drag down the overall proxy success rate. During IP rotation:

1. IP rotation command is sent to the proxy
2. Proxy takes 2-4 seconds to rotate the IP
3 During this window, the continuous testing loop continues making requests
4. These requests fail because the proxy is mid-rotation
5. Failures are counted in the overall success rate, skewing metrics

## Solution

Modified the metrics system to **track success/failure per request source** and provide filtered success rate calculations that exclude periodic rotation verification requests.

## Changes Made

### 1. **Enhanced Metrics Tracking** (`src/lib/metrics.ts`)

#### Added source-specific counters:
```typescript
interface Metrics {
  // ... existing fields
  // NEW: Source-specific success/failure tracking
  continuousSuccessful: number;
  continuousFailed: number;
  periodicRotationSuccessful: number;
  periodicRotationFailed: number;
  manualSuccessful: number;
  manualFailed: number;
}
```

#### Updated `recordRequest()`:
Now tracks success/failure counts separately for each source:
- `continuous` - Normal proxy testing (every 5 seconds)
- `periodic_rotation` - IP rotation verification requests
- `manual` - Manual API testing

#### New Functions:

**`getContinuousSuccessRate()`**
- Returns success rate **excluding** `periodic_rotation` requests
- Only includes `continuous` + `manual` requests
- **Use this for accurate proxy health monitoring**

**`getSuccessRateBySource()`**
- Returns breakdown of success rates by source:
  ```typescript
  {
    overall: number;           // All requests (same as getSuccessRate())
    continuous: number;        // Only continuous testing
    periodicRotation: number;  // Only rotation verification
    manual: number;           // Only manual tests
    continuousOnly: number;   // continuous + manual (excludes periodic_rotation)
  }
  ```

### 2. **Updated Health Checks** (`src/api/health.ts`)

- Now uses `getContinuousSuccessRate()` instead of `getSuccessRate()` for health status
- Health response includes both rates:
  ```json
  {
    "metrics": {
      "successRate": 82.5,              // Overall (includes rotation failures)
      "continuousSuccessRate": 95.2,    // Excluding rotation (true proxy health)
      "successRateBySource": {
        "overall": 82.5,
        "continuous": 95.5,
        "periodicRotation": 45.2,       // Low during rotation window
        "manual": 100.0,
        "continuousOnly": 95.2
      }
    }
  }
  ```

### 3. **Updated Monitoring Alerts** (`src/lib/monitoring.ts`)

- Alert thresholds now use `getContinuousSuccessRate()` to prevent false alarms
- High error rate alert (< 50%): Uses continuous success rate
- Low success rate warning (< 90%): Uses continuous success rate
- Alert metadata includes both overall and continuous rates for context

### 4. **Enhanced Prometheus Metrics**

New metrics exported at `/metrics` endpoint:

```prometheus
# Overall success rate (all requests)
proxy_tester_success_rate 82.5

# Continuous success rate (excluding periodic rotation)
proxy_tester_continuous_success_rate 95.2

# Per-source success rates
proxy_tester_success_rate_by_source{source="continuous"} 95.5
proxy_tester_success_rate_by_source{source="periodic_rotation"} 45.2
proxy_tester_success_rate_by_source{source="manual"} 100.0
```

## How It Works

### Request Flow:

1. **Continuous Testing** (every 5 seconds):
   ```typescript
   recordRequest(metrics.success, metrics.responseTimeMs, 'continuous');
   saveProxyTestToDatabase(device, metrics, 'continuous');
   ```

2. **Periodic Rotation Verification**:
   ```typescript
   recordRequest(metrics.success, metrics.responseTimeMs, 'periodic_rotation');
   saveProxyTestToDatabase(device, metrics, 'periodic_rotation');
   ```

3. **Database Storage**:
   - Source is stored in `proxy_requests.source` column
   - Can be filtered in SQL queries for aggregations
   - Hourly summaries can be updated to filter by source if needed

## Benefits

✅ **Accurate Monitoring**: Success rate now reflects actual proxy health, not rotation side-effects  
✅ **No False Alarms**: Alerts won't trigger during normal IP rotation operations  
✅ **Granular Insights**: Can monitor rotation success rate separately  
✅ **Historical Analysis**: Database stores source, enabling retroactive analysis  
✅ **Prometheus Ready**: Metrics are properly labeled for Grafana dashboards  

## Usage Examples

### Get continuous success rate (excludes rotation):
```typescript
import { getContinuousSuccessRate } from '../lib/metrics';

const healthSuccessRate = getContinuousSuccessRate();
console.log(`Proxy health: ${healthSuccessRate.toFixed(2)}%`);
```

### Get detailed breakdown:
```typescript
import { getSuccessRateBySource } from '../lib/metrics';

const breakdown = getSuccessRateBySource();
console.log(`Continuous: ${breakdown.continuous}%`);
console.log(`Rotation: ${breakdown.periodicRotation}%`);
```

### Grafana Prometheus Query Examples:

**Continuous Success Rate (Recommended for dashboards):**
```prometheus
proxy_tester_continuous_success_rate
```

**Compare Overall vs Continuous:**
```prometheus
proxy_tester_success_rate - proxy_tester_continuous_success_rate
```

**Rotation Impact:**
```prometheus
proxy_tester_success_rate_by_source{source="periodic_rotation"}
```

### Grafana SQL Query Examples (Direct Database):

#### **1. Main Success Rate (Excludes Periodic Rotation) - RECOMMENDED:**
```sql
SELECT COUNT(CASE WHEN r.status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as value 
FROM proxy_requests r 
JOIN proxies p ON r.proxy_id = p.device_id 
WHERE $__timeFilter(r.timestamp) 
  AND p.location IN ($location)
  AND r.source IN ('continuous', 'manual')  -- ✅ Exclude rotation tests
```

#### **2. Success Rate Over Time (Continuous Only):**
```sql
SELECT 
  $__timeGroupAlias(r.timestamp, $__interval),
  COUNT(CASE WHEN r.status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as value
FROM proxy_requests r 
JOIN proxies p ON r.proxy_id = p.device_id 
WHERE $__timeFilter(r.timestamp) 
  AND p.location IN ($location)
  AND r.source IN ('continuous', 'manual')
GROUP BY 1
ORDER BY 1
```

#### **3. Success Rate by Source (Debugging):**
```sql
SELECT 
  r.source,
  COUNT(CASE WHEN r.status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as success_rate,
  COUNT(*) as total_requests
FROM proxy_requests r 
JOIN proxies p ON r.proxy_id = p.device_id 
WHERE $__timeFilter(r.timestamp) 
  AND p.location IN ($location)
GROUP BY r.source
```

#### **4. Compare Overall vs Continuous:**
```sql
SELECT 
  $__timeGroupAlias(r.timestamp, $__interval),
  COUNT(CASE WHEN r.status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as "Overall",
  COUNT(CASE WHEN r.status = 'SUCCESS' AND r.source IN ('continuous', 'manual') THEN 1 END) * 100.0 / 
    NULLIF(COUNT(CASE WHEN r.source IN ('continuous', 'manual') THEN 1 END), 0) as "Continuous Only"
FROM proxy_requests r 
JOIN proxies p ON r.proxy_id = p.device_id 
WHERE $__timeFilter(r.timestamp) 
  AND p.location IN ($location)
GROUP BY 1
ORDER BY 1
```

#### **5. Rotation Health (Separate Panel):**
```sql
SELECT 
  $__timeGroupAlias(r.timestamp, $__interval),
  COUNT(CASE WHEN r.status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as "Rotation Success Rate"
FROM proxy_requests r 
WHERE $__timeFilter(r.timestamp) 
  AND r.source = 'periodic_rotation'
GROUP BY 1
ORDER BY 1
```

### SQL Verification Query:

**Check what's in your database:**
```sql
SELECT 
  source,
  COUNT(*) as count,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) as successful,
  COUNT(CASE WHEN status != 'SUCCESS' THEN 1 END) as failed,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as success_rate
FROM proxy_requests
WHERE timestamp >= NOW() - INTERVAL 1 HOUR
GROUP BY source
ORDER BY count DESC;
```

## Database Considerations

The `proxy_requests` table already has a `source` column that stores the request source:

```sql
SELECT 
  source,
  COUNT(*) as total,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) as successful,
  (COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) / COUNT(*)) * 100 as success_rate
FROM proxy_requests
WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY source;
```

**Optional Enhancement**: Update `hourly-summary.ts` to calculate per-source aggregations if needed for faster Grafana queries.

## Backward Compatibility

✅ Existing metrics and functions still work  
✅ `getSuccessRate()` returns overall rate (unchanged behavior)  
✅ New functions are additive, not breaking  
✅ Database schema unchanged (source column already exists)  

## Migration

No migration needed! Changes are:
- ✅ In-memory metrics (reset on service restart)
- ✅ Additive exports (no breaking changes)
- ✅ Database source column already in use

Just restart the service to get the new functionality.

## Recommendations

### For Monitoring Dashboards:
- **Primary Metric**: Use `proxy_tester_continuous_success_rate` or `getContinuousSuccessRate()`
- **Debugging**: Show both overall and continuous rates to identify rotation impact
- **Rotation Health**: Monitor `proxy_tester_success_rate_by_source{source="periodic_rotation"}` separately

### For Alerts:
- ✅ Already updated to use continuous success rate
- ✅ Include both metrics in alert metadata for context

### For Analysis:
- Compare `continuousOnly` vs `periodicRotation` to measure rotation impact
- If rotation success rate is consistently low, increase wait times in config
