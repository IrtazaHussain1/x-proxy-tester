#!/bin/bash
# Quick Fix Script for Production Issues
# Fixes: 1) Missing database column, 2) Grafana dashboard updates

set -e

echo "=========================================="
echo "Fixing Production Issues"
echo "=========================================="

# Get database credentials from environment or use defaults
MYSQL_USER=${MYSQL_USER:-xproxy}
MYSQL_PASSWORD=${MYSQL_PASSWORD:-xproxy}
MYSQL_DATABASE=${MYSQL_DATABASE:-xproxy_tester}
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD:-root}

echo ""
echo "1. Fixing Database: Adding missing 'source' column..."
echo "   Checking if column exists..."

# Check if column exists
COLUMN_EXISTS=$(docker compose exec -T mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} -sN -e "
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = '${MYSQL_DATABASE}' 
    AND TABLE_NAME = 'proxy_requests' 
    AND COLUMN_NAME = 'source'
" 2>/dev/null || echo "0")

if [ "$COLUMN_EXISTS" = "0" ]; then
  echo "   Column doesn't exist, adding it..."
  docker compose exec -T mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} ${MYSQL_DATABASE} <<EOF
ALTER TABLE proxy_requests ADD COLUMN source VARCHAR(191) NULL DEFAULT 'continuous';
CREATE INDEX proxy_requests_source_idx ON proxy_requests(source);
EOF
  echo "   ✅ Column 'source' added successfully"
else
  echo "   ✅ Column 'source' already exists"
fi

echo ""
echo "2. Restarting app to apply database changes..."
docker compose restart app
echo "   ✅ App restarted"

echo ""
echo "3. Fixing Grafana: Reloading dashboards..."
echo "   Restarting Grafana to pick up dashboard changes..."
docker compose restart grafana
echo "   ✅ Grafana restarted"

echo ""
echo "4. Waiting for services to be healthy (15 seconds)..."
sleep 15

echo ""
echo "5. Verification:"
echo "   Checking database column:"
docker compose exec mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} -e "
  USE ${MYSQL_DATABASE};
  DESCRIBE proxy_requests;
" | grep source && echo "   ✅ Database column verified" || echo "   ❌ Database column not found"

echo ""
echo "   Checking Grafana dashboard time range:"
DASHBOARD_CHECK=$(docker compose exec grafana cat /var/lib/grafana/dashboards/overview-dashboard.json 2>/dev/null | grep -c "now-30m" || echo "0")
if [ "$DASHBOARD_CHECK" -gt "0" ]; then
  echo "   ✅ Dashboard files updated to 30 minutes"
else
  echo "   ⚠️  Dashboard files may not be updated. Check if files are mounted correctly."
fi

echo ""
echo "=========================================="
echo "Fix Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Check app logs: docker compose logs app --tail 50"
echo "2. Verify no more 'source' column errors"
echo "3. Open Grafana: http://your-server:3312"
echo "4. Check dashboard time range is now 30 minutes"
echo ""
echo "If Grafana still shows 24h:"
echo "  - Go to Grafana UI → Configuration → Dashboards → Click 'Reload'"
echo "  - Or manually import dashboards from grafana/dashboards/ folder"

