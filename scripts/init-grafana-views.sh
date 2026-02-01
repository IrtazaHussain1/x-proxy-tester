#!/bin/sh
# Initialize Grafana views in MySQL
# NOTE: This script runs during MySQL initialization (first time only, when data directory is empty).
# On fresh database starts, it detects no tables exist and exits immediately, letting the app handle initialization.
# If tables already exist, it initializes views and indexes immediately.
# Note: Uses /bin/sh for Alpine Linux compatibility

set +e  # Don't exit on error - allow graceful failure

MYSQL_HOST="${MYSQL_HOST:-localhost}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-xproxy}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-xproxy}"
MYSQL_DATABASE="${MYSQL_DATABASE:-xproxy_tester}"

# Wait for MySQL to be ready (with timeout)
MAX_WAIT=60  # Maximum 60 seconds to wait for MySQL
WAIT_COUNT=0
until mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" -e "SELECT 1" &>/dev/null; do
  if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    echo "MySQL not ready after ${MAX_WAIT} seconds. Skipping Grafana views initialization."
    echo "The application will initialize Grafana views after tables are created."
    exit 0
  fi
  sleep 1
  WAIT_COUNT=$((WAIT_COUNT + 1))
done

# Check if this is a fresh database (no tables exist)
# On fresh database initialization, tables are created by Prisma when the app starts,
# so we should exit early and let the app handle initialization
TABLE_COUNT=$(mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" -e "SHOW TABLES" 2>/dev/null | wc -l)

if [ "$TABLE_COUNT" -le 1 ]; then
  # Fresh database - no tables exist yet (wc -l includes header line, so <= 1 means no tables)
  echo "Fresh database detected (no tables found). Skipping Grafana views initialization."
  echo "The application will initialize Grafana views after Prisma creates the tables."
  exit 0
fi

# Check if the proxies table exists (main table we need)
if ! mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" -e "SHOW TABLES LIKE 'proxies'" 2>/dev/null | grep -q "proxies"; then
  # Tables exist but not the proxies table - might be in progress, wait briefly
  echo "Database has tables but 'proxies' table not found. Waiting briefly..."
  MAX_TABLE_WAIT=30  # Maximum 30 seconds to wait
  TABLE_WAIT_COUNT=0
  until mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" -e "SHOW TABLES LIKE 'proxies'" 2>/dev/null | grep -q "proxies"; do
    if [ $TABLE_WAIT_COUNT -ge $MAX_TABLE_WAIT ]; then
      echo "Proxies table not found after ${MAX_TABLE_WAIT} seconds. The application will initialize Grafana views after tables are created."
      exit 0
    fi
    sleep 2
    TABLE_WAIT_COUNT=$((TABLE_WAIT_COUNT + 2))
  done
fi

echo "Tables found, initializing Grafana views and indexes..."

# Execute Grafana views SQL
if [ -f "/app/grafana-views.sql" ]; then
  mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < /app/grafana-views.sql 2>/dev/null
  echo "Grafana views initialized successfully"
elif [ -f "./grafana-views.sql" ]; then
  mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < ./grafana-views.sql 2>/dev/null
  echo "Grafana views initialized successfully"
else
  echo "grafana-views.sql not found. The application will initialize views after tables are created."
fi

# Execute Grafana views optimization SQL (indexes)
if [ -f "/app/grafana-views-optimized.sql" ]; then
  mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < /app/grafana-views-optimized.sql 2>/dev/null
  echo "Grafana views optimization indexes initialized successfully"
elif [ -f "./grafana-views-optimized.sql" ]; then
  mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < ./grafana-views-optimized.sql 2>/dev/null
  echo "Grafana views optimization indexes initialized successfully"
else
  echo "grafana-views-optimized.sql not found. Skipping optimization indexes."
fi
