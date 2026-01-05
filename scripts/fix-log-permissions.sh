#!/bin/bash

# Fix Log Permissions Script
# This script fixes permissions for the logs directory so the Docker container
# can write log files. The container runs as user nodejs (UID 1001).

set -e

LOGS_DIR="./logs"

echo "Fixing permissions for logs directory..."

# Create logs directory if it doesn't exist
mkdir -p "${LOGS_DIR}"

# Option 1: Make it writable by everyone (simplest, but less secure)
chmod 777 "${LOGS_DIR}"

# Option 2: Change ownership to match container user (more secure)
# Uncomment the line below if you prefer this approach
# chown -R 1001:1001 "${LOGS_DIR}"

echo "✓ Permissions fixed for ${LOGS_DIR}"
echo ""
echo "The container should now be able to write log files."
echo ""
echo "To verify, check the directory permissions:"
echo "  ls -ld ${LOGS_DIR}"


