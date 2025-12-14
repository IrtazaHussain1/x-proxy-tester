#!/bin/bash

# Database Backup Script
# This script creates a backup of the MySQL database from the Docker container
# and saves it to a timestamped file that can be downloaded

set -e

# Configuration - adjust these if needed
CONTAINER_NAME="x-proxy-tester-mysql"
DB_NAME="${MYSQL_DATABASE:-xproxy_tester}"
DB_USER="${MYSQL_USER:-xproxy}"
DB_PASSWORD="${MYSQL_PASSWORD:-xproxy}"
BACKUP_DIR="./backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/xproxy_tester_backup_${TIMESTAMP}.sql"
BACKUP_FILE_COMPRESSED="${BACKUP_FILE}.gz"

# Create backup directory if it doesn't exist
mkdir -p "${BACKUP_DIR}"

echo "Starting database backup..."
echo "Container: ${CONTAINER_NAME}"
echo "Database: ${DB_NAME}"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container ${CONTAINER_NAME} is not running!"
    exit 1
fi

# Create the backup using mysqldump inside the container
echo "Creating SQL dump..."
docker exec "${CONTAINER_NAME}" mysqldump \
    -u"${DB_USER}" \
    -p"${DB_PASSWORD}" \
    --single-transaction \
    --routines \
    --triggers \
    --events \
    "${DB_NAME}" > "${BACKUP_FILE}"

# Check if backup was successful
if [ $? -eq 0 ] && [ -f "${BACKUP_FILE}" ] && [ -s "${BACKUP_FILE}" ]; then
    echo "Backup created successfully: ${BACKUP_FILE}"
    
    # Compress the backup
    echo "Compressing backup..."
    gzip -f "${BACKUP_FILE}"
    
    if [ -f "${BACKUP_FILE_COMPRESSED}" ]; then
        BACKUP_SIZE=$(du -h "${BACKUP_FILE_COMPRESSED}" | cut -f1)
        echo "✓ Backup compressed successfully!"
        echo "  File: ${BACKUP_FILE_COMPRESSED}"
        echo "  Size: ${BACKUP_SIZE}"
        echo ""
        echo "To download from server, use one of these methods:"
        echo ""
        echo "1. Using SCP (from your local machine):"
        echo "   scp user@server:$(pwd)/${BACKUP_FILE_COMPRESSED} ./"
        echo ""
        echo "2. Using rsync (from your local machine):"
        echo "   rsync -avz user@server:$(pwd)/${BACKUP_FILE_COMPRESSED} ./"
        echo ""
        echo "3. Using HTTP (if you have a web server):"
        echo "   Copy ${BACKUP_FILE_COMPRESSED} to your web server directory"
        echo ""
        echo "4. Using Docker cp (from server):"
        echo "   # First, copy from container to server filesystem (if needed)"
        echo "   # Then use scp/rsync to download"
    else
        echo "Error: Compression failed!"
        exit 1
    fi
else
    echo "Error: Backup failed!"
    exit 1
fi
