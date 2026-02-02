#!/bin/sh
# Run Grafana views initialization from app container
# This script can be run manually or called from the application
# It works even when MySQL volumes already exist
# Note: Uses /bin/sh for Alpine Linux compatibility

set +e  # Don't exit on error - allow graceful failure

# Get MySQL connection details from environment or use defaults
MYSQL_HOST="${MYSQL_HOST:-mysql}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-xproxy}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-xproxy}"
MYSQL_DATABASE="${MYSQL_DATABASE:-xproxy_tester}"

echo "=========================================="
echo "Grafana Views Initialization Script"
echo "=========================================="
echo "Host: ${MYSQL_HOST}:${MYSQL_PORT}"
echo "Database: ${MYSQL_DATABASE}"
echo ""

# Wait for MySQL to be ready (with timeout)
MAX_WAIT=60  # Maximum 60 seconds to wait for MySQL
WAIT_COUNT=0
echo "Waiting for MySQL to be ready..."
until mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" -e "SELECT 1" &>/dev/null; do
  if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    echo "❌ MySQL not ready after ${MAX_WAIT} seconds. Exiting."
    exit 1
  fi
  sleep 1
  WAIT_COUNT=$((WAIT_COUNT + 1))
done
echo "✅ MySQL is ready"

# Wait for tables to be created (with timeout)
# Tables are created by Prisma when the app starts, so we need to wait
MAX_TABLE_WAIT=120  # Maximum 120 seconds to wait for tables (2 minutes)
TABLE_WAIT_COUNT=0
echo "Waiting for database tables to be created..."
until mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" -e "SHOW TABLES LIKE 'proxies'" 2>/dev/null | grep -q "proxies"; do
  if [ $TABLE_WAIT_COUNT -ge $MAX_TABLE_WAIT ]; then
    echo "⚠️  Tables not found after ${MAX_TABLE_WAIT} seconds."
    echo "   The application will initialize Grafana views after tables are created."
    exit 0
  fi
  if [ $((TABLE_WAIT_COUNT % 10)) -eq 0 ]; then
    echo "   Still waiting for tables... (${TABLE_WAIT_COUNT}/${MAX_TABLE_WAIT}s)"
  fi
  sleep 2
  TABLE_WAIT_COUNT=$((TABLE_WAIT_COUNT + 2))
done

echo "✅ Tables found, initializing Grafana views and indexes..."
echo ""

# Execute Grafana views SQL
if [ -f "/app/grafana-views.sql" ]; then
  echo "📝 Executing grafana-views.sql..."
  if mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < /app/grafana-views.sql 2>/dev/null; then
    echo "✅ Grafana views initialized successfully"
  else
    echo "⚠️  Some errors occurred while initializing views (may already exist)"
  fi
elif [ -f "./grafana-views.sql" ]; then
  echo "📝 Executing grafana-views.sql..."
  if mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < ./grafana-views.sql 2>/dev/null; then
    echo "✅ Grafana views initialized successfully"
  else
    echo "⚠️  Some errors occurred while initializing views (may already exist)"
  fi
else
  echo "⚠️  grafana-views.sql not found. Skipping views initialization."
fi

# Execute Grafana views optimization SQL (indexes)
if [ -f "/app/grafana-views-optimized.sql" ]; then
  echo "📝 Executing grafana-views-optimized.sql..."
  if mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < /app/grafana-views-optimized.sql 2>/dev/null; then
    echo "✅ Grafana views optimization indexes initialized successfully"
  else
    echo "⚠️  Some errors occurred while initializing indexes (may already exist)"
  fi
elif [ -f "./grafana-views-optimized.sql" ]; then
  echo "📝 Executing grafana-views-optimized.sql..."
  if mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < ./grafana-views-optimized.sql 2>/dev/null; then
    echo "✅ Grafana views optimization indexes initialized successfully"
  else
    echo "⚠️  Some errors occurred while initializing indexes (may already exist)"
  fi
else
  echo "⚠️  grafana-views-optimized.sql not found. Skipping optimization indexes."
fi

echo ""
echo "=========================================="
echo "✅ Grafana views initialization complete!"
echo "=========================================="
