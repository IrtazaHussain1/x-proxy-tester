#!/bin/bash

# Data Purging Script
# This script finds logs and SQL backup files older than 2 weeks,
# creates backups, compresses them, and deletes the originals to save space
#
# Usage:
#   ./scripts/purge-old-data.sh          # Run normally
#   ./scripts/purge-old-data.sh --dry-run # Preview what would be purged (no changes)
#   ./scripts/purge-old-data.sh -n        # Same as --dry-run
#
# The script will:
# 1. Find files older than 2 weeks in ./logs and ./backups directories
# 2. Create backups in ./archives directory
# 3. Compress the files (if not already compressed)
# 4. Move compressed files to archives
# 5. Delete original files (after successful backup and compression)

set -e

# Configuration
RETENTION_DAYS=14
LOGS_DIR="./logs"
BACKUPS_DIR="./backups"
ARCHIVE_DIR="./archives"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
PURGE_LOG="${ARCHIVE_DIR}/purge_${TIMESTAMP}.log"

# Check for dry-run mode
DRY_RUN=false
if [[ "$1" == "--dry-run" ]] || [[ "$1" == "-n" ]]; then
    DRY_RUN=true
    echo "Running in DRY-RUN mode (no files will be modified)"
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create necessary directories
mkdir -p "${ARCHIVE_DIR}"
mkdir -p "${BACKUPS_DIR}"

# Logging function
log() {
    echo -e "${1}" | tee -a "${PURGE_LOG}"
}

log_info() {
    log "${GREEN}[INFO]${NC} ${1}"
}

log_warn() {
    log "${YELLOW}[WARN]${NC} ${1}"
}

log_error() {
    log "${RED}[ERROR]${NC} ${1}"
}

# Function to get file age in days
get_file_age_days() {
    local file="$1"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS - use stat to get modification time
        local file_timestamp=$(stat -f "%m" "$file" 2>/dev/null || echo "0")
    else
        # Linux
        local file_timestamp=$(stat -c %Y "$file" 2>/dev/null || echo "0")
    fi
    
    if [[ "$file_timestamp" == "0" ]]; then
        echo "0"
        return
    fi
    
    local current_timestamp=$(date +%s)
    local age_seconds=$((current_timestamp - file_timestamp))
    echo $((age_seconds / 86400))
}

# Function to backup and compress files
backup_and_compress() {
    local file="$1"
    local file_dir=$(dirname "$file")
    local file_name=$(basename "$file")
    local archive_subdir="${ARCHIVE_DIR}/$(basename "$file_dir")_${TIMESTAMP}"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY-RUN] Would backup and compress: ${file}"
        log_info "[DRY-RUN] Would create archive in: ${archive_subdir}"
        return 0
    fi
    
    mkdir -p "${archive_subdir}"
    
    # Create backup copy first
    local backup_file="${archive_subdir}/${file_name}"
    log_info "Backing up: ${file} -> ${backup_file}"
    cp "$file" "$backup_file"
    
    # Compress the original file
    if [[ "$file" == *.gz ]] || [[ "$file" == *.zip ]] || [[ "$file" == *.tar ]]; then
        log_info "File ${file} is already compressed, skipping compression"
        # Just move it to archive
        mv "$file" "${archive_subdir}/"
    else
        log_info "Compressing: ${file}"
        gzip -f "$file"
        
        if [[ -f "${file}.gz" ]]; then
            log_info "Compressed: ${file}.gz"
            # Move compressed file to archive
            mv "${file}.gz" "${archive_subdir}/"
        else
            log_error "Compression failed for: ${file}"
            return 1
        fi
    fi
    
    return 0
}

# Function to purge files from a directory
purge_directory() {
    local dir="$1"
    local pattern="$2"
    local description="$3"
    
    if [[ ! -d "$dir" ]]; then
        log_warn "Directory ${dir} does not exist, skipping ${description}"
        return 0
    fi
    
    log_info "Scanning ${description} in: ${dir}"
    
    local files_found=0
    local files_processed=0
    local total_size_saved=0
    
    # Find files matching pattern and older than retention period
    while IFS= read -r -d '' file; do
        files_found=$((files_found + 1))
        local age_days=$(get_file_age_days "$file")
        
        if [[ $age_days -ge $RETENTION_DAYS ]]; then
            local file_size=$(du -b "$file" | cut -f1)
            log_info "Found ${description}: ${file} (age: ${age_days} days, size: $(du -h "$file" | cut -f1))"
            
            if backup_and_compress "$file"; then
                files_processed=$((files_processed + 1))
                total_size_saved=$((total_size_saved + file_size))
                log_info "Successfully processed: ${file}"
            else
                log_error "Failed to process: ${file}"
            fi
        fi
    done < <(find "$dir" -type f -name "$pattern" -print0 2>/dev/null || true)
    
    if [[ $files_found -eq 0 ]]; then
        log_info "No ${description} files found in ${dir}"
    else
        log_info "Processed ${files_processed}/${files_found} ${description} files"
        log_info "Total size saved: $(numfmt --to=iec-i --suffix=B $total_size_saved 2>/dev/null || echo "${total_size_saved} bytes")"
    fi
}

# Function to purge old database records (optional)
purge_database_records() {
    local container_name="${MYSQL_CONTAINER_NAME:-x-proxy-tester-mysql}"
    local db_name="${MYSQL_DATABASE:-xproxy_tester}"
    local db_user="${MYSQL_USER:-xproxy}"
    local db_password="${MYSQL_PASSWORD:-xproxy}"
    
    # Check if container is running
    if ! docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        log_warn "Container ${container_name} is not running, skipping database record purging"
        return 0
    fi
    
    log_info "Purging database records older than ${RETENTION_DAYS} days..."
    
    # Create a temporary SQL file for purging
    local purge_sql="${ARCHIVE_DIR}/purge_db_${TIMESTAMP}.sql"
    
    cat > "$purge_sql" <<EOF
-- Database Purging Script
-- Generated on $(date)
-- Retention period: ${RETENTION_DAYS} days

-- Note: Adjust these queries based on your schema
-- Example queries (uncomment and modify as needed):

-- DELETE FROM proxy_requests WHERE created_at < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY);
-- DELETE FROM test_results WHERE created_at < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY);
-- DELETE FROM archived_data WHERE archived_at < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY);

-- To see what would be deleted (dry run):
-- SELECT COUNT(*) FROM proxy_requests WHERE created_at < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY);
-- SELECT COUNT(*) FROM test_results WHERE created_at < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY);

EOF
    
    log_info "Database purge SQL script created: ${purge_sql}"
    log_warn "Database record purging is disabled by default. Review ${purge_sql} and run manually if needed."
    log_warn "To enable automatic purging, uncomment the DELETE statements in the script."
}

# Main execution
main() {
    log_info "=========================================="
    log_info "Starting Data Purging Process"
    if [[ "$DRY_RUN" == "true" ]]; then
        log_warn "DRY-RUN MODE: No files will be modified"
    fi
    log_info "Retention period: ${RETENTION_DAYS} days"
    log_info "Timestamp: ${TIMESTAMP}"
    log_info "=========================================="
    echo ""
    
    # Purge log files
    log_info "--- Processing Log Files ---"
    purge_directory "${LOGS_DIR}" "*.log" "log files"
    purge_directory "${LOGS_DIR}" "*.log.*" "rotated log files"
    echo ""
    
    # Purge SQL backup files (both compressed and uncompressed)
    log_info "--- Processing SQL Backup Files ---"
    purge_directory "${BACKUPS_DIR}" "*.sql" "SQL backup files"
    purge_directory "${BACKUPS_DIR}" "*.sql.gz" "compressed SQL backup files"
    echo ""
    
    # Optional: Purge database records
    log_info "--- Database Record Purging ---"
    purge_database_records
    echo ""
    
    # Summary
    log_info "=========================================="
    log_info "Purging Process Completed"
    log_info "Archive directory: ${ARCHIVE_DIR}"
    log_info "Purge log: ${PURGE_LOG}"
    log_info "=========================================="
    
    # Show archive directory size
    if [[ -d "${ARCHIVE_DIR}" ]]; then
        local archive_size=$(du -sh "${ARCHIVE_DIR}" | cut -f1)
        log_info "Total archive size: ${archive_size}"
    fi
}

# Run main function
main

