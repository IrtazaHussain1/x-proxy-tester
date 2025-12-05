#!/bin/bash
# Initialize Grafana views in MySQL
# This script should be run after the database schema is created

set -e

MYSQL_HOST="${MYSQL_HOST:-mysql}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-xproxy}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-xproxy}"
MYSQL_DATABASE="${MYSQL_DATABASE:-xproxy_tester}"

echo "Waiting for MySQL to be ready and tables to exist..."

# Wait for MySQL to be ready
until mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" -e "SELECT 1" &>/dev/null; do
  echo "Waiting for MySQL..."
  sleep 2
done

# Wait for tables to exist (check if proxies table exists)
MAX_RETRIES=30
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" -e "SHOW TABLES LIKE 'proxies'" 2>/dev/null | grep -q "proxies"; then
    echo "Tables found, initializing Grafana views..."
    break
  fi
  echo "Waiting for tables to be created... ($RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "Warning: Tables not found after $MAX_RETRIES retries. Views will be created when tables exist."
  exit 0
fi

# Execute Grafana views SQL
if [ -f "/app/grafana-views.sql" ]; then
  mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < /app/grafana-views.sql
  echo "Grafana views initialized successfully"
elif [ -f "./grafana-views.sql" ]; then
  mysql -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DATABASE}" < ./grafana-views.sql
  echo "Grafana views initialized successfully"
else
  echo "Warning: grafana-views.sql not found. Views will need to be created manually."
fi
