#!/bin/bash
# Production Migration Script - Add Device API Fields
# Safe migration that backs up database and applies changes without data loss

set -e

echo "=========================================="
echo "Production Migration: Add Device API Fields"
echo "=========================================="
echo ""

# Configuration
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD:-root}
MYSQL_DATABASE=${MYSQL_DATABASE:-xproxy_tester}
BACKUP_DIR=${BACKUP_DIR:-./backups}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz"

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "Step 1/6: Creating database backup..."
docker compose exec -T mysql mysqldump -u root -p${MYSQL_ROOT_PASSWORD} \
  --single-transaction \
  --routines \
  --triggers \
  ${MYSQL_DATABASE} | gzip > "$BACKUP_FILE"

if [ -f "$BACKUP_FILE" ] && [ -s "$BACKUP_FILE" ]; then
  BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "✅ Backup created: $BACKUP_FILE ($BACKUP_SIZE)"
else
  echo "❌ Backup failed!"
  exit 1
fi

echo ""
echo "Step 2/6: Verifying database connection..."
docker compose exec -T mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} -e "SELECT 1" > /dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "✅ Database connection verified"
else
  echo "❌ Database connection failed!"
  exit 1
fi

echo ""
echo "Step 3/6: Applying migration..."
echo "   (This migration is idempotent - safe to run multiple times)"
docker compose exec -T mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} ${MYSQL_DATABASE} < \
  prisma/migrations/20251211103947_add_all_device_fields/migration.sql

if [ $? -eq 0 ]; then
  echo "✅ Migration applied successfully"
else
  echo "❌ Migration failed!"
  echo ""
  echo "To restore from backup, run:"
  echo "  gunzip < $BACKUP_FILE | docker compose exec -T mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} ${MYSQL_DATABASE}"
  exit 1
fi

echo ""
echo "Step 4/6: Verifying migration..."
COLUMN_COUNT=$(docker compose exec -T mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} -sN -e "
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = '${MYSQL_DATABASE}' 
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME IN ('device_api_id', 'model', 'ip_address', 'ws_status', 'proxy_status', 'country', 'state', 'city', 'street', 'longitude', 'latitude', 'relay_server_id', 'relay_server_ip_address', 'download_net_speed', 'upload_net_speed', 'last_ip_rotation')
" 2>/dev/null || echo "0")

if [ "$COLUMN_COUNT" -ge "10" ]; then
  echo "✅ Migration verified: $COLUMN_COUNT new columns found"
else
  echo "⚠️  Warning: Only $COLUMN_COUNT new columns found (expected at least 10)"
fi

echo ""
echo "Step 5/6: Regenerating Prisma Client..."
docker compose exec app npx prisma generate

if [ $? -eq 0 ]; then
  echo "✅ Prisma Client regenerated"
else
  echo "⚠️  Warning: Prisma Client regeneration failed (may need to rebuild container)"
fi

echo ""
echo "Step 6/6: Restarting application..."
docker compose restart app
echo "✅ Application restarted"

echo ""
echo "=========================================="
echo "Migration Complete!"
echo "=========================================="
echo ""
echo "Backup location: $BACKUP_FILE"
echo ""
echo "Next steps:"
echo "1. Monitor application logs: docker compose logs -f app"
echo "2. Check health endpoint: curl http://localhost:3000/health"
echo "3. (Optional) Populate existing records:"
echo "   docker compose exec app npx tsx scripts/backfill-device-fields.ts"
echo ""
