-- Export verification data for cycle ID: 126590c0-ec73-4d56-bf40-8517caa907b6
-- Run this query and export results as CSV

SELECT 
    rc.id AS cycle_id,
    ir.proxy_id,
    5 AS max_attempts,  -- Default max attempts from config
    CASE 
        WHEN ir.success = 1 THEN 'SUCCESS'
        WHEN ir.success = 0 THEN 'FAILED'
        ELSE 'PENDING'
    END AS final_status,
    ir.retry_count,
    COALESCE(ir.wait_time_ms, 0) AS wait_time_ms,
    ir.verified_at,
    ir.error_message,
    ir.verification_method,
    ir.rotation_duration_ms
FROM 
    rotation_cycles rc
JOIN 
    ip_rotations ir ON rc.id = ir.cycle_id
WHERE 
    rc.id = '126590c0-ec73-4d56-bf40-8517caa907b6'
ORDER BY 
    ir.proxy_id ASC;
