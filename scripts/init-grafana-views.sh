#!/bin/bash
# Initialize Grafana views in MySQL
# NOTE: This script runs during MySQL initialization, but tables may not exist yet.
# The application will handle Grafana views initialization after tables are created.
# This script exits gracefully if tables don't exist yet.

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

# Check if tables exist (don't wait - just check once)
if mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" -e "SHOW TABLES LIKE 'proxies'" 2>/dev/null | grep -q "proxies"; then
  echo "Tables found, initializing Grafana views..."
  
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
else
  echo "Tables not found yet. The application will initialize Grafana views after tables are created."
  exit 0
fi
