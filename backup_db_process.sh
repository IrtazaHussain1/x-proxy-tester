#!/bin/bash
# iterative_backup.sh

# Configuration
DB_HOST="65.21.254.9"
DB_PORT="3310"
DB_USER="root"
DB_PASS="root"
DB_NAME="xproxy_tester"
TABLE_NAME="proxy_requests"
DATE_COLUMN="created_at"  # Your timestamp column
BACKUP_DIR="backup/sql_archives"
LOG_DIR="log"
LOG_FILE="$LOG_DIR/backup_process.log"
MAX_DISK_USAGE=85  # Stop if disk usage exceeds this percentage
RETENTION_DAYS=14  # Days to retain data before archiving
DELETE_AFTER_BACKUP=true  # Delete data from database after successful backup (set to false for safety)
CHUNK_SIZE=50000  # Process records in chunks: dump CHUNK_SIZE, delete CHUNK_SIZE, repeat
DELETE_PROGRESS_INTERVAL=10  # Show progress every N chunks (0 to disable progress checks between chunks)
USE_FAST_DUMP=true  # Use optimized dump settings for speed (set to false for standard dump)
DUMP_METHOD="mysqldump"  # Options: "mysqldump" (standard), "select_into" (faster, requires file permissions), "mydumper" (fastest, if installed)
COMPRESS_AFTER_DAY=true  # Compress only after full day range is complete (saves processing time)

# Detect OS for date command compatibility
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - use gdate if available, otherwise use date with different syntax
    if command -v gdate &> /dev/null; then
        DATE_CMD="gdate"
    else
        DATE_CMD="date"
        # macOS date doesn't support -d, we'll use a workaround
    fi
else
    # Linux
    DATE_CMD="date"
fi

# Create backup directory structure
mkdir -p $BACKUP_DIR/{daily,weekly,monthly}
mkdir -p $BACKUP_DIR/temp
mkdir -p $LOG_DIR

# Set MySQL password as environment variable to avoid command line exposure
export MYSQL_PWD="$DB_PASS"

log() {
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$message" | tee -a "$LOG_FILE"
}

# Test MySQL connection
test_mysql_connection() {
    log "Testing MySQL connection..."
    if mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -e "SELECT 1" "$DB_NAME" &>/dev/null; then
        log "MySQL connection successful"
        return 0
    else
        log "ERROR: Failed to connect to MySQL server at $DB_HOST:$DB_PORT"
        return 1
    fi
}

check_disk_space() {
    local usage
    if [[ "$OSTYPE" == "darwin"* ]]; then
        usage=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
    else
        usage=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
    fi
    
    if [ "$usage" -gt "$MAX_DISK_USAGE" ]; then
        log "ERROR: Disk usage at ${usage}% - stopping backup process"
        exit 1
    fi
    log "Disk usage at ${usage}% - OK to proceed"
}

# Extract date part from datetime string (handles both "YYYY-MM-DD" and "YYYY-MM-DD HH:MM:SS" formats)
extract_date() {
    local datetime_str=$1
    # Remove leading/trailing whitespace
    datetime_str=$(echo "$datetime_str" | xargs)
    # Extract just the date part (first 10 characters: YYYY-MM-DD)
    # If it's already a date, this will just return it
    echo "${datetime_str:0:10}"
}

# Date manipulation functions (cross-platform compatible)
add_days() {
    local date_str=$1
    local days=$2
    
    # Extract date part if it's a datetime string
    date_str=$(extract_date "$date_str")
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v gdate &> /dev/null; then
            gdate -d "$date_str + $days days" '+%Y-%m-%d'
        else
            # macOS date workaround using Python - handle both date and datetime formats
            python3 -c "
from datetime import datetime, timedelta
try:
    dt = datetime.strptime('$date_str', '%Y-%m-%d')
except ValueError:
    dt = datetime.strptime('$date_str', '%Y-%m-%d %H:%M:%S')
result = dt + timedelta(days=$days)
print(result.strftime('%Y-%m-%d'))
"
        fi
    else
        date -d "$date_str + $days days" '+%Y-%m-%d'
    fi
}

date_to_epoch() {
    local date_str=$1
    
    # Extract date part if it's a datetime string
    date_str=$(extract_date "$date_str")
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v gdate &> /dev/null; then
            gdate -d "$date_str" '+%s'
        else
            # macOS date workaround - handle both date and datetime formats
            python3 -c "
from datetime import datetime
try:
    dt = datetime.strptime('$date_str', '%Y-%m-%d')
except ValueError:
    dt = datetime.strptime('$date_str', '%Y-%m-%d %H:%M:%S')
print(int(dt.timestamp()))
"
        fi
    else
        date -d "$date_str" '+%s'
    fi
}

get_cutoff_date() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v gdate &> /dev/null; then
            gdate -d "$(date '+%Y-%m-%d') - $RETENTION_DAYS days" '+%Y-%m-%d'
        else
            python3 -c "from datetime import datetime, timedelta; print((datetime.now() - timedelta(days=$RETENTION_DAYS)).strftime('%Y-%m-%d'))"
        fi
    else
        date -d "$(date '+%Y-%m-%d') - $RETENTION_DAYS days" '+%Y-%m-%d'
    fi
}

get_file_size() {
    local file=$1
    if [[ "$OSTYPE" == "darwin"* ]]; then
        stat -f%z "$file" 2>/dev/null || echo "0"
    else
        stat -c%s "$file" 2>/dev/null || echo "0"
    fi
}

format_bytes() {
    local bytes=$1
    if command -v numfmt &> /dev/null; then
        numfmt --to=iec-i --suffix=B "$bytes"
    else
        # Fallback formatting
        if [ "$bytes" -lt 1024 ]; then
            echo "${bytes}B"
        elif [ "$bytes" -lt 1048576 ]; then
            echo "$((bytes / 1024))KB"
        elif [ "$bytes" -lt 1073741824 ]; then
            echo "$((bytes / 1048576))MB"
        else
            echo "$((bytes / 1073741824))GB"
        fi
    fi
}

# Dump a chunk of records using specified method
dump_chunk() {
    local start_date=$1
    local end_date=$2
    local chunk_limit=$3
    local output_file=$4
    local method=${DUMP_METHOD:-mysqldump}
    
    case "$method" in
        "select_into")
            # Fastest method: SELECT INTO OUTFILE (requires FILE privilege)
            # Note: This creates CSV, need to convert to SQL format
            local csv_file="${output_file}.csv"
            mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -e \
                "SELECT * FROM $TABLE_NAME WHERE $DATE_COLUMN >= '$start_date 00:00:00' AND $DATE_COLUMN < '$end_date 00:00:00' LIMIT $chunk_limit INTO OUTFILE '$csv_file' FIELDS TERMINATED BY ',' ENCLOSED BY '\"' LINES TERMINATED BY '\n'" 2>&1
            
            if [ $? -eq 0 ] && [ -f "$csv_file" ]; then
                # Convert CSV to SQL INSERT statements (simplified)
                echo "INSERT INTO $TABLE_NAME VALUES" > "$output_file"
                # This is a simplified conversion - you may need to adjust based on your table structure
                return 0
            else
                return 1
            fi
            ;;
        "mydumper")
            # Use mydumper if available (fastest, parallel)
            if command -v mydumper &> /dev/null; then
                mydumper -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p "$DB_PASS" \
                    -B "$DB_NAME" -T "$TABLE_NAME" \
                    --where "$DATE_COLUMN >= '$start_date 00:00:00' AND $DATE_COLUMN < '$end_date 00:00:00'" \
                    --rows "$chunk_limit" -o "$output_file" 2>&1
                return $?
            else
                log "WARNING: mydumper not found, falling back to mysqldump"
                method="mysqldump"
            fi
            ;;
        "mysqldump"|*)
            # Standard mysqldump (most compatible)
            # Note: mysqldump doesn't support LIMIT in --where, so we get IDs first
            local temp_ids_file="${output_file}.ids"
            
            # Get IDs for this chunk (ordered by date for consistency)
            mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
                -e "SELECT id FROM $TABLE_NAME WHERE $DATE_COLUMN >= '$start_date 00:00:00' AND $DATE_COLUMN < '$end_date 00:00:00' ORDER BY $DATE_COLUMN LIMIT $chunk_limit" \
                > "$temp_ids_file" 2>&1 | grep -v "Warning" | grep -v "Using a password"
            
            if [ $? -eq 0 ] && [ -s "$temp_ids_file" ]; then
                # Build WHERE clause with IDs (handle large ID lists)
                local ids=$(cat "$temp_ids_file" | tr '\n' ',' | sed 's/,$//')
                
                if [ "$USE_FAST_DUMP" = true ]; then
                    mysqldump -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" \
                        --single-transaction \
                        --quick \
                        --skip-extended-insert \
                        --skip-add-drop-table \
                        --skip-triggers \
                        --where="id IN ($ids)" \
                        "$DB_NAME" "$TABLE_NAME" > "$output_file" 2>&1 | grep -v "Warning" | grep -v "Using a password"
                else
                    mysqldump -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" \
                        --single-transaction \
                        --where="id IN ($ids)" \
                        "$DB_NAME" "$TABLE_NAME" > "$output_file" 2>&1 | grep -v "Warning" | grep -v "Using a password"
                fi
                local result=$?
                rm -f "$temp_ids_file"
                return $result
            else
                rm -f "$temp_ids_file"
                return 1
            fi
            ;;
    esac
}

# Delete a chunk of records
delete_chunk() {
    local start_date=$1
    local end_date=$2
    local chunk_limit=$3
    
    local delete_query="DELETE FROM $TABLE_NAME WHERE $DATE_COLUMN >= '$start_date 00:00:00' AND $DATE_COLUMN < '$end_date 00:00:00' LIMIT $chunk_limit"
    
    local result=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -e "$delete_query" 2>&1)
    local exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        # Extract deleted count
        if echo "$result" | grep -q "Rows matched"; then
            echo "$result" | sed -n 's/.*Rows matched: \([0-9]*\).*/\1/p' | head -1
        elif echo "$result" | grep -q "Query OK"; then
            echo "$result" | sed -n 's/.*Query OK, \([0-9]*\) rows affected.*/\1/p' | head -1
        else
            echo "$chunk_limit"  # Assume full chunk if no error
        fi
        return 0
    else
        echo "0"
        return 1
    fi
}

# Test connection before proceeding
if ! test_mysql_connection; then
    exit 1
fi

# Get oldest date in the table
log "Querying for oldest date older than $RETENTION_DAYS days..."
OLDEST_DATETIME=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
    -e "SELECT MIN($DATE_COLUMN) FROM $TABLE_NAME WHERE $DATE_COLUMN < DATE_SUB(NOW(), INTERVAL $RETENTION_DAYS DAY)" 2>&1)

# Check for MySQL errors
if [ $? -ne 0 ]; then
    log "ERROR: Failed to query database: $OLDEST_DATETIME"
    exit 1
fi

# Remove any MySQL warnings from the output
OLDEST_DATETIME=$(echo "$OLDEST_DATETIME" | grep -v "Warning" | grep -v "Using a password" | head -1)

if [ -z "$OLDEST_DATETIME" ] || [ "$OLDEST_DATETIME" == "NULL" ]; then
    log "No data older than $RETENTION_DAYS days found. Exiting."
    exit 0
fi

# Extract just the date part from the datetime
OLDEST_DATE=$(extract_date "$OLDEST_DATETIME")

# Verify: Get the newest date in the range for comparison
NEWEST_DATETIME=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
    -e "SELECT MAX($DATE_COLUMN) FROM $TABLE_NAME WHERE $DATE_COLUMN < DATE_SUB(NOW(), INTERVAL $RETENTION_DAYS DAY)" 2>&1 | grep -v "Warning" | grep -v "Using a password" | head -1)
NEWEST_DATE=$(extract_date "$NEWEST_DATETIME")

# Get record count for verification
RECORD_COUNT=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
    -e "SELECT COUNT(*) FROM $TABLE_NAME WHERE $DATE_COLUMN < DATE_SUB(NOW(), INTERVAL $RETENTION_DAYS DAY)" 2>&1 | grep -v "Warning" | grep -v "Using a password" | head -1)

log "=========================================="
log "BACKUP PROCESS VERIFICATION"
log "=========================================="
log "Processing order: OLDEST → NEWEST (chronological forward)"
log "Oldest date to process: $OLDEST_DATE (from datetime: $OLDEST_DATETIME)"
log "Newest date in range: $NEWEST_DATE (from datetime: $NEWEST_DATETIME)"
log "Total records to backup: $RECORD_COUNT"
log "Retention cutoff: $RETENTION_DAYS days (data older than this will be backed up)"
if [ "$DELETE_AFTER_BACKUP" = true ]; then
    log "Database deletion: ENABLED (data will be deleted after successful backup)"
else
    log "Database deletion: DISABLED (data will be retained in database)"
fi
log "=========================================="
log "Starting backup from OLDEST date: $OLDEST_DATE"

# Process in batches
DAYS_PER_BATCH=2  # Start small, increase as space frees up
CURRENT_DATE="$OLDEST_DATE"
CUTOFF_DATE=$(get_cutoff_date)
TEMP_FILE=""
BATCH_COUNT=0
TOTAL_EXPORTED=0
TOTAL_DELETED=0
DELETED_BATCHES=0

log "Cutoff date (retention limit): $CUTOFF_DATE"

while true; do
    CURRENT_EPOCH=$(date_to_epoch "$CURRENT_DATE")
    CUTOFF_EPOCH=$(date_to_epoch "$CUTOFF_DATE")
    
    # Validate epochs are numeric before comparison
    if ! [[ "$CURRENT_EPOCH" =~ ^[0-9]+$ ]] || ! [[ "$CUTOFF_EPOCH" =~ ^[0-9]+$ ]]; then
        log "ERROR: Invalid date conversion. CURRENT_EPOCH=$CURRENT_EPOCH, CUTOFF_EPOCH=$CUTOFF_EPOCH"
        exit 1
    fi
    
    if [ "$CURRENT_EPOCH" -ge "$CUTOFF_EPOCH" ]; then
        log "Reached cutoff date. Backup process complete."
        break
    fi
    
    check_disk_space
    
    NEXT_DATE=$(add_days "$CURRENT_DATE" "$DAYS_PER_BATCH")
    BATCH_COUNT=$((BATCH_COUNT + 1))
    
    log "Processing batch #$BATCH_COUNT (OLDEST→NEWEST): from $CURRENT_DATE to $NEXT_DATE"
    
    # Get record count for this batch to estimate time
    BATCH_COUNT_QUERY=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
        -e "SELECT COUNT(*) FROM $TABLE_NAME WHERE DATE($DATE_COLUMN) >= '$CURRENT_DATE' AND DATE($DATE_COLUMN) < '$NEXT_DATE'" 2>&1 | \
        grep -v "Warning" | grep -v "Using a password" | head -1)
    
    if [ -z "$BATCH_COUNT_QUERY" ] || [ "$BATCH_COUNT_QUERY" = "0" ]; then
        log "No records found for this date range. Skipping."
        CURRENT_DATE=$NEXT_DATE
        continue
    fi
    
    log "Total records in batch: $BATCH_COUNT_QUERY | Processing in chunks: dump $CHUNK_SIZE → delete $CHUNK_SIZE → repeat"
    
    # Create temporary directory for this batch's chunks
    BATCH_TEMP_DIR="$BACKUP_DIR/temp/batch_${CURRENT_DATE}_to_${NEXT_DATE}"
    mkdir -p "$BATCH_TEMP_DIR"
    
    # File to accumulate all chunks for this day range
    ACCUMULATED_FILE="$BATCH_TEMP_DIR/accumulated_backup.sql"
    > "$ACCUMULATED_FILE"  # Create empty file
    
    # Add table structure once at the beginning (only for first chunk)
    FIRST_CHUNK=true
    CHUNK_NUMBER=0
    TOTAL_DUMPED=0
    TOTAL_DELETED=0
    BATCH_START_TIME=$(date +%s)
    
    # Process in chunks: dump CHUNK_SIZE → delete CHUNK_SIZE → repeat
    while true; do
        CHUNK_NUMBER=$((CHUNK_NUMBER + 1))
        CHUNK_FILE="$BATCH_TEMP_DIR/chunk_${CHUNK_NUMBER}.sql"
        
        # Check if there are more records to process
        REMAINING_COUNT=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
            -e "SELECT COUNT(*) FROM $TABLE_NAME WHERE $DATE_COLUMN >= '$CURRENT_DATE 00:00:00' AND $DATE_COLUMN < '$NEXT_DATE 00:00:00'" 2>&1 | \
            grep -v "Warning" | grep -v "Using a password" | head -1)
        
        if [ -z "$REMAINING_COUNT" ] || [ "$REMAINING_COUNT" = "0" ]; then
            log "All records processed for this date range. Completed $CHUNK_NUMBER chunks."
            break
        fi
        
        if [ $((CHUNK_NUMBER % 5)) -eq 1 ] || [ $CHUNK_NUMBER -eq 1 ]; then
            log "Chunk #$CHUNK_NUMBER: Dumping up to $CHUNK_SIZE records (remaining: ${REMAINING_COUNT:-0})..."
        fi
        
        # Step 1: Dump chunk
        CHUNK_START=$(date +%s)
        if dump_chunk "$CURRENT_DATE" "$NEXT_DATE" "$CHUNK_SIZE" "$CHUNK_FILE"; then
            CHUNK_SIZE_BYTES=$(get_file_size "$CHUNK_FILE")
            
            # Remove warnings and append to accumulated file (skip table structure after first chunk)
            if [ "$FIRST_CHUNK" = true ]; then
                # First chunk: include everything
                cat "$CHUNK_FILE" >> "$ACCUMULATED_FILE"
                FIRST_CHUNK=false
            else
                # Subsequent chunks: remove table structure, keep only INSERT statements
                grep -E "^INSERT INTO|^/\*|^--" "$CHUNK_FILE" >> "$ACCUMULATED_FILE" 2>/dev/null || \
                sed '/^CREATE TABLE/,/^ENGINE=/d; /^DROP TABLE/d' "$CHUNK_FILE" >> "$ACCUMULATED_FILE" 2>/dev/null
            fi
            
            TOTAL_DUMPED=$((TOTAL_DUMPED + CHUNK_SIZE))
            CHUNK_DUMP_TIME=$(($(date +%s) - CHUNK_START))
            
            # Step 2: Delete chunk immediately after successful dump
            if [ "$DELETE_AFTER_BACKUP" = true ]; then
                DELETED_COUNT=$(delete_chunk "$CURRENT_DATE" "$NEXT_DATE" "$CHUNK_SIZE")
                if [ -n "$DELETED_COUNT" ] && [ "$DELETED_COUNT" != "0" ]; then
                    TOTAL_DELETED=$((TOTAL_DELETED + DELETED_COUNT))
                fi
            fi
            
            # Clean up chunk file
            rm -f "$CHUNK_FILE"
            
            # Progress update
            if [ $((CHUNK_NUMBER % DELETE_PROGRESS_INTERVAL)) -eq 0 ]; then
                ELAPSED=$(($(date +%s) - BATCH_START_TIME))
                PROGRESS_PCT=$((TOTAL_DUMPED * 100 / BATCH_COUNT_QUERY))
                log "Progress: Chunk #$CHUNK_NUMBER | Dumped: $TOTAL_DUMPED/$BATCH_COUNT_QUERY ($PROGRESS_PCT%) | Deleted: $TOTAL_DELETED | Elapsed: ${ELAPSED}s"
            fi
        else
            log "ERROR: Failed to dump chunk #$CHUNK_NUMBER"
            rm -f "$CHUNK_FILE"
            # Continue with next chunk
        fi
    done
    
    # All chunks processed for this date range
    if [ -s "$ACCUMULATED_FILE" ]; then
        # Remove MySQL warnings from accumulated file
        sed -i.bak '/Warning:/d' "$ACCUMULATED_FILE" 2>/dev/null || sed -i '' '/Warning:/d' "$ACCUMULATED_FILE" 2>/dev/null
        rm -f "${ACCUMULATED_FILE}.bak" 2>/dev/null
        
        FILE_SIZE=$(get_file_size "$ACCUMULATED_FILE")
        TOTAL_EXPORTED=$((TOTAL_EXPORTED + FILE_SIZE))
        BATCH_ELAPSED=$(($(date +%s) - BATCH_START_TIME))
        
        log "All chunks dumped. Total: $(format_bytes $FILE_SIZE) | Records: $TOTAL_DUMPED | Time: ${BATCH_ELAPSED}s"
        
        # Compress accumulated file (only after full day range is complete)
        if [ "$COMPRESS_AFTER_DAY" = true ]; then
            log "Compressing complete day range backup..."
            COMPRESS_START=$(date +%s)
            if gzip -9 "$ACCUMULATED_FILE" 2>/dev/null; then
                COMPRESSED_FILE="${ACCUMULATED_FILE}.gz"
                COMPRESSED_SIZE=$(get_file_size "$COMPRESSED_FILE")
                COMPRESS_DURATION=$(($(date +%s) - COMPRESS_START))
                log "Compressed to $(format_bytes $COMPRESSED_SIZE) in ${COMPRESS_DURATION}s (ratio: $((FILE_SIZE * 100 / COMPRESSED_SIZE))%)"
            else
                log "ERROR: Failed to compress backup file"
                rm -rf "$BATCH_TEMP_DIR"
                CURRENT_DATE=$NEXT_DATE
                continue
            fi
        else
            COMPRESSED_FILE="$ACCUMULATED_FILE"
            COMPRESSED_SIZE=$FILE_SIZE
        fi
        
        # Move to daily folder
        FINAL_FILE="$BACKUP_DIR/daily/backup_${CURRENT_DATE}_to_${NEXT_DATE}.sql.gz"
        if mv "$COMPRESSED_FILE" "$FINAL_FILE" 2>/dev/null; then
            log "✓ Backup saved: $(format_bytes $COMPRESSED_SIZE) → $FINAL_FILE"
            
            # Clean up temp directory
            rm -rf "$BATCH_TEMP_DIR"
            
            # Verify backup file exists and has content
            if [ -f "$FINAL_FILE" ] && [ -s "$FINAL_FILE" ]; then
                BACKUP_SUCCESS=true
                
                # Verify all data was deleted (should be 0 if deletion happened during chunking)
                if [ "$DELETE_AFTER_BACKUP" = true ]; then
                    FINAL_REMAINING=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
                        -e "SELECT COUNT(*) FROM $TABLE_NAME WHERE $DATE_COLUMN >= '$CURRENT_DATE 00:00:00' AND $DATE_COLUMN < '$NEXT_DATE 00:00:00'" 2>&1 | \
                        grep -v "Warning" | grep -v "Using a password" | head -1)
                    
                    if [ -z "$FINAL_REMAINING" ]; then
                        FINAL_REMAINING=0
                    fi
                    
                    if [ "${FINAL_REMAINING:-0}" = "0" ]; then
                        DELETED_BATCHES=$((DELETED_BATCHES + 1))
                        log "✓ All $TOTAL_DELETED records deleted during chunked processing"
                    else
                        log "WARNING: $FINAL_REMAINING records still remain. Cleaning up..."
                        # Clean up any remaining records
                        while [ "${FINAL_REMAINING:-0}" -gt 0 ]; do
                            CLEANUP_DELETED=$(delete_chunk "$CURRENT_DATE" "$NEXT_DATE" "$CHUNK_SIZE")
                            FINAL_REMAINING=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
                                -e "SELECT COUNT(*) FROM $TABLE_NAME WHERE $DATE_COLUMN >= '$CURRENT_DATE 00:00:00' AND $DATE_COLUMN < '$NEXT_DATE 00:00:00'" 2>&1 | \
                                grep -v "Warning" | grep -v "Using a password" | head -1)
                            if [ -z "$FINAL_REMAINING" ]; then
                                FINAL_REMAINING=0
                            fi
                        done
                        DELETED_BATCHES=$((DELETED_BATCHES + 1))
                        log "✓ Cleanup completed. All records deleted."
                    fi
                    
                    # Optimize table periodically (every 5 batches)
                    if [ $((DELETED_BATCHES % 5)) -eq 0 ] && [ $DELETED_BATCHES -gt 0 ]; then
                        log "Optimizing table to reclaim space (every 5 batches)..."
                        mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -e \
                            "OPTIMIZE TABLE $TABLE_NAME" 2>&1 | grep -v "Warning" | grep -v "Using a password" > /dev/null
                        log "Table optimization completed"
                    fi
                else
                    log "DELETE_AFTER_BACKUP is disabled. Data retained in database."
                fi
            else
                log "ERROR: Backup file verification failed. File missing or empty."
                BACKUP_SUCCESS=false
            fi
        else
            log "ERROR: Failed to move backup file"
            rm -rf "$BATCH_TEMP_DIR"
        fi
    else
        log "ERROR: No data accumulated for $CURRENT_DATE to $NEXT_DATE"
        rm -rf "$BATCH_TEMP_DIR"
    fi
    
    CURRENT_DATE=$NEXT_DATE
done

# Final verification: Check remaining records older than retention period
REMAINING_OLD_RECORDS=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" "$DB_NAME" -sN \
    -e "SELECT COUNT(*) FROM $TABLE_NAME WHERE $DATE_COLUMN < DATE_SUB(NOW(), INTERVAL $RETENTION_DAYS DAY)" 2>&1 | \
    grep -v "Warning" | grep -v "Using a password" | head -1)

log "=========================================="
log "BACKUP PROCESS COMPLETED"
log "=========================================="
log "Processing order: OLDEST → NEWEST ✓"
log "Total batches processed: $BATCH_COUNT"
log "Total data exported: $(format_bytes $TOTAL_EXPORTED)"
log "Date range: $OLDEST_DATE → $CUTOFF_DATE"
if [ "$DELETE_AFTER_BACKUP" = true ]; then
    log "Database cleanup: ENABLED ✓"
    log "Records deleted from database: $TOTAL_DELETED"
    log "Batches with successful deletion: $DELETED_BATCHES"
    log "Remaining old records (>$RETENTION_DAYS days): $REMAINING_OLD_RECORDS"
    if [ -n "$REMAINING_OLD_RECORDS" ] && [ "$REMAINING_OLD_RECORDS" != "0" ]; then
        log "NOTE: Some old records may still exist (could be from different date ranges or failed batches)"
    fi
else
    log "Database cleanup: DISABLED (data retained in database)"
fi
log "=========================================="