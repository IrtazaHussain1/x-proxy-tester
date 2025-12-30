# Database Backup and Download Guide

This guide explains how to backup your MySQL database from the Docker container and download it to your local machine.

## Quick Start

Run the backup script on your server:

```bash
./scripts/backup-database.sh
```

This will create a compressed SQL backup file in the `backups/` directory.

## Method 1: Using SCP (Recommended)

From your **local machine**, download the backup:

```bash
# Replace 'user' and 'server' with your actual SSH credentials
scp user@your-server:/path/to/x-proxy-tester/backups/xproxy_tester_backup_YYYYMMDD_HHMMSS.sql.gz ./
```

## Method 2: Using rsync

From your **local machine**, download the backup:

```bash
# Replace 'user' and 'server' with your actual SSH credentials
rsync -avz --progress user@your-server:/path/to/x-proxy-tester/backups/xproxy_tester_backup_*.sql.gz ./
```

## Method 3: Using Docker cp (if container is on remote server)

If you need to copy directly from the container:

```bash
# On the server, copy from container to local filesystem
docker cp x-proxy-tester-mysql:/tmp/backup.sql.gz ./backups/

# Then use scp/rsync to download from server
```

## Method 4: Manual mysqldump

If you prefer to run mysqldump manually:

```bash
# On the server
docker exec x-proxy-tester-mysql mysqldump \
    -uxproxy \
    -pxproxy \
    --single-transaction \
    --routines \
    --triggers \
    --events \
    xproxy_tester | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

## Restoring a Backup

To restore a backup on your server:

```bash
# Decompress the backup
gunzip xproxy_tester_backup_YYYYMMDD_HHMMSS.sql.gz

# Restore to database
docker exec -i x-proxy-tester-mysql mysql \
    -uxproxy \
    -pxproxy \
    xproxy_tester < xproxy_tester_backup_YYYYMMDD_HHMMSS.sql
```

Or in one command:

```bash
gunzip -c xproxy_tester_backup_YYYYMMDD_HHMMSS.sql.gz | \
docker exec -i x-proxy-tester-mysql mysql \
    -uxproxy \
    -pxproxy \
    xproxy_tester
```

## Automated Backups

You can set up a cron job for automatic daily backups:

```bash
# Edit crontab
crontab -e

# Add this line for daily backups at 2 AM
0 2 * * * cd /path/to/x-proxy-tester && ./scripts/backup-database.sh >> /var/log/db-backup.log 2>&1
```

## Data Purging and Cleanup

To save disk space, you can use the automated purge script to compress and archive old logs and SQL backup files older than 2 weeks:

### Quick Start

```bash
# Preview what would be purged (dry-run mode)
./scripts/purge-old-data.sh --dry-run

# Actually purge old files
./scripts/purge-old-data.sh
```

### What the Script Does

The purge script (`purge-old-data.sh`) will:

1. **Find old files**: Scans `./logs` and `./backups` directories for files older than 14 days
2. **Create backups**: Creates backup copies in `./archives` directory before any modifications
3. **Compress files**: Compresses uncompressed files using gzip
4. **Archive files**: Moves compressed files to the archive directory
5. **Delete originals**: Removes original files from their original locations (after successful backup)

### Files Processed

- **Log files**: `*.log` and `*.log.*` files in `./logs` directory
- **SQL backups**: `*.sql` and `*.sql.gz` files in `./backups` directory

### Archive Structure

Purged files are organized in the `./archives` directory by type and timestamp:

```
archives/
├── logs_20240101_120000/
│   ├── app.log.gz
│   └── error.log.gz
├── backups_20240101_120000/
│   ├── xproxy_tester_backup_20231215_000000.sql.gz
│   └── xproxy_tester_backup_20231220_000000.sql.gz
└── purge_20240101_120000.log
```

### Configuration

You can modify the retention period by editing the script:

```bash
# Edit the script to change retention period (default: 14 days)
vim scripts/purge-old-data.sh
# Change: RETENTION_DAYS=14
```

### Automated Purging

Set up a cron job for weekly purging:

```bash
# Edit crontab
crontab -e

# Add this line for weekly purging every Sunday at 3 AM
0 3 * * 0 cd /path/to/x-proxy-tester && ./scripts/purge-old-data.sh >> /var/log/purge.log 2>&1
```

### Safety Features

- **Dry-run mode**: Test what would be purged without making changes
- **Backup first**: All files are backed up before compression/deletion
- **Detailed logging**: All operations are logged to `./archives/purge_TIMESTAMP.log`
- **Error handling**: Script stops on errors to prevent data loss

### Manual Backup Retention

If you prefer manual cleanup of old backups:

```bash
# Keep only last 7 days of backups
find ./backups -name "*.sql.gz" -mtime +7 -delete
```

## Environment Variables

The backup script uses these environment variables (with defaults):
- `MYSQL_DATABASE` (default: `xproxy_tester`)
- `MYSQL_USER` (default: `xproxy`)
- `MYSQL_PASSWORD` (default: `xproxy`)

If your `.env` file has different values, export them before running the script:

```bash
export $(cat .env | xargs)
./scripts/backup-database.sh
```

## Troubleshooting

### Container not running
If you get "Container is not running" error:
```bash
docker-compose ps
docker-compose up -d mysql
```

### Permission denied
Make sure the script is executable:
```bash
chmod +x scripts/backup-database.sh
```

### Backup file is empty
Check database credentials and container name:
```bash
docker exec x-proxy-tester-mysql mysql -uxproxy -pxproxy -e "SHOW DATABASES;"
```
