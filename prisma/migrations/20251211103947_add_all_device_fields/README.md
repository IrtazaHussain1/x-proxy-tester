# Migration: Add All Device API Fields

This migration adds all missing fields from the Device API to the `proxies` table.

## Fields Added

- `device_api_id` (INT) - Numeric ID from API
- `model` (VARCHAR(100)) - Device model
- `ip_address` (VARCHAR(45)) - Device IP address
- `ws_status` (VARCHAR(50)) - WebSocket status
- `proxy_status` (VARCHAR(50)) - Proxy status from API
- `country` (VARCHAR(100)) - Country location
- `state` (VARCHAR(100)) - State/Province location
- `city` (VARCHAR(100)) - City location
- `street` (VARCHAR(255)) - Street address
- `longitude` (DOUBLE) - Geographic longitude
- `latitude` (DOUBLE) - Geographic latitude
- `relay_server_id` (INT) - Relay server ID
- `relay_server_ip_address` (VARCHAR(45)) - Relay server IP address
- `download_net_speed` (DOUBLE) - Download network speed
- `upload_net_speed` (DOUBLE) - Upload network speed
- `last_ip_rotation` (VARCHAR(50)) - Last IP rotation timestamp from API

## Indexes Added

- `idx_proxies_proxy_status` - Index on `proxy_status`
- `idx_proxies_country` - Index on `country`
- `idx_proxies_state` - Index on `state`
- `idx_proxies_city` - Index on `city`

## How to Apply

### For Production (Docker - Recommended)

**Use the migration script** (idempotent, includes backup):
```bash
./scripts/migrate-production.sh
```

Or manually apply the migration SQL:
```bash
docker compose exec -T mysql mysql -u root -p${MYSQL_ROOT_PASSWORD} ${MYSQL_DATABASE} < \
  prisma/migrations/20251211103947_add_all_device_fields/migration.sql
```

### For Development

**Standard Prisma migration:**
```bash
npx prisma migrate deploy
```
Or:
```bash
npx prisma migrate dev
```

**Note:** The `migration.sql` file is idempotent - it checks if columns exist before adding them, making it safe to run multiple times.

2. **Regenerate Prisma Client:**
   ```bash
   npx prisma generate
   ```

3. **Backfill existing data (optional but recommended):**
   ```bash
   npx tsx scripts/backfill-device-fields.ts
   ```

   This script will:
   - Fetch all devices from the API
   - Update all existing proxy records with the new Device API fields
   - Log progress and results

## Notes

- All new fields are nullable to allow for existing records
- The backfill script will populate all fields from the API for existing records
- New records created after this migration will automatically include all Device API fields
- The code has been updated to populate all fields when creating/updating proxies

