#!/bin/bash
# Export verification data for a specific cycle ID to CSV
# Usage: ./scripts/export-verification-data.sh <cycleId>

CYCLE_ID="${1:-126590c0-ec73-4d56-bf40-8517caa907b6}"

echo "Exporting verification data for cycle ID: $CYCLE_ID"
echo ""

# Run SQL query and export to CSV
docker exec x-proxy-tester-mysql mysql -uroot -proot xproxy_tester \
  -e "SELECT 
        rc.id AS cycle_id,
        ir.proxy_id,
        5 AS max_attempts,
        CASE 
            WHEN ir.success = 1 THEN 'SUCCESS'
            WHEN ir.success = 0 THEN 'FAILED'
            ELSE 'PENDING'
        END AS final_status,
        ir.retry_count,
        COALESCE(ir.wait_time_ms, 0) AS wait_time_ms,
        ir.verified_at,
        IFNULL(ir.error_message, '') AS error_message,
        IFNULL(ir.verification_method, '') AS verification_method,
        COALESCE(ir.rotation_duration_ms, 0) AS rotation_duration_ms
      FROM 
        rotation_cycles rc
      JOIN 
        ip_rotations ir ON rc.id = ir.cycle_id
      WHERE 
        rc.id = '$CYCLE_ID'
      ORDER BY 
        ir.proxy_id ASC;" \
  --batch --raw | \
  sed 's/\t/,/g' > "verification-data-${CYCLE_ID}.csv"

echo "✅ CSV file saved to: verification-data-${CYCLE_ID}.csv"
echo ""
echo "Summary:"
docker exec x-proxy-tester-mysql mysql -uroot -proot xproxy_tester \
  -e "SELECT 
        COUNT(*) AS total_rotations,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
        AVG(retry_count) AS avg_retry_count,
        MAX(retry_count) AS max_retry_count
      FROM 
        ip_rotations
      WHERE 
        cycle_id = '$CYCLE_ID';" \
  --batch --raw
