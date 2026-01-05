#!/bin/bash

# Database Restore Script
# This script restores a MySQL database backup to the Docker container

set -e

# Configuration
CONTAINER_NAME="x-proxy-tester-mysql"
DB_NAME="${MYSQL_DATABASE:-xproxy_tester}"
DB_USER="${MYSQL_USER:-xproxy}"
DB_PASSWORD="${MYSQL_PASSWORD:-xproxy}"

# Check if backup file is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <backup_file.sql.gz or backup_file.sql>"
    echo ""
    echo "Example:"
    echo "  $0 backups/xproxy_tester_backup_20240101_120000.sql.gz"
    exit 1
fi

BACKUP_FILE="$1"

# Check if file exists
if [ ! -f "${BACKUP_FILE}" ]; then
    echo "Error: Backup file '${BACKUP_FILE}' not found!"
    exit 1
fi

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container ${CONTAINER_NAME} is not running!"
    exit 1
fi

echo "WARNING: This will replace all data in the database!"
echo "Database: ${DB_NAME}"
echo "Backup file: ${BACKUP_FILE}"
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [ "${confirm}" != "yes" ]; then
    echo "Restore cancelled."
    exit 0
fi

echo "Starting database restore..."

# Check if file is compressed
if [[ "${BACKUP_FILE}" == *.gz ]]; then
    echo "Decompressing and restoring..."
    gunzip -c "${BACKUP_FILE}" | \
    docker exec -i "${CONTAINER_NAME}" mysql \
        -u"${DB_USER}" \
        -p"${DB_PASSWORD}" \
        "${DB_NAME}"
else
    echo "Restoring..."
    docker exec -i "${CONTAINER_NAME}" mysql \
        -u"${DB_USER}" \
        -p"${DB_PASSWORD}" \
        "${DB_NAME}" < "${BACKUP_FILE}"
fi

if [ $? -eq 0 ]; then
    echo "✓ Database restored successfully!"
else
    echo "Error: Restore failed!"
    exit 1
fi
