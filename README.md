# XProxy Tester

Automated proxy testing system that continuously evaluates all available proxies from the XProxy Portal, measuring uptime, stability, IP rotation behavior, and real-world usability.

## Features

- **Proxy List Management**: Automatically fetches and refreshes proxy list from XProxy Portal API every 6 hours
- **Continuous Testing**: Tests each proxy every 5 seconds with configurable timeouts
- **IP Rotation Detection**: Tracks IP changes, rotation count, and flags proxies that don't rotate after threshold attempts
- **Stability Monitoring**: Calculates uptime and classifies proxies as Stable, Unstable (Hourly), or Unstable (Daily)
vi- **Comprehensive Logging**: Stores all test results in MySQL with detailed metrics
- **Type-Safe Configuration**: Centralized configuration management with validation

## Tech Stack

- **Runtime**: Node.js 20 with TypeScript
- **Database**: MySQL with Prisma ORM 6
- **HTTP Client**: undici with ProxyAgent for high-performance proxy requests
- **Logging**: Pino (structured logging with pretty output)
- **Configuration**: Centralized config module with validation

## Prerequisites

- Node.js 20+
- MySQL (local installation)
- XProxy Portal API credentials

## Quick Start

### 1. Clone and Setup

```bash
git clone <repository-url>
cd x-proxy-tester
npm install
```

### 2. Setup MySQL Database

Ensure MySQL is running locally, then create the database:

```bash
# Option 1: Use the setup script
./scripts/setup-mysql.sh

# Option 2: Manual setup
mysql -u root -e "CREATE DATABASE IF NOT EXISTS xproxy_tester;"
```

### 3. Configure Environment

Copy the example environment file and update with your credentials:

```bash
cp env.example .env
```

Edit `.env` with your configuration:

```env
# Database (MySQL)
DATABASE_URL="mysql://root@localhost:3306/xproxy_tester"

# XProxy Portal API
XPROXY_API_URL="https://proxyapi.jumpermedia.co/v2/"
XPROXY_API_TOKEN="your-api-token-here"
XPROXY_API_TIMEOUT_MS=30000

# Testing Configuration
TEST_TARGET_URL="https://api.ipify.org?format=json"
TEST_INTERVAL_MS=5000
REQUEST_TIMEOUT_MS=30000
ROTATION_THRESHOLD=10

# Refresh Configuration
PROXY_REFRESH_INTERVAL_MS=21600000

# Stability Calculation
STABILITY_CHECK_INTERVAL_MS=600000

# Logging
LOG_LEVEL="info"
```

### 4. Initialize Database

```bash
# Generate Prisma Client
npm run db:generate

# Push schema to database
npm run db:push
```

### 5. Run Application

```bash
# Development mode (with hot reload)
npm run dev

# Production build
npm run build
npm start
```

The application will:
- Fetch all devices from XProxy Portal API
- Start testing each device every 5 seconds
- Save all results to MySQL database
- Calculate stability every 10 minutes
- Refresh device list every 6 hours

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DATABASE_URL` | MySQL connection string | - | ✅ Yes |
| `XPROXY_API_URL` | XProxy Portal API base URL | - | ✅ Yes |
| `XPROXY_API_TOKEN` | API authentication token | - | ✅ Yes |
| `XPROXY_API_TIMEOUT_MS` | API request timeout in milliseconds | `30000` | No |
| `TEST_TARGET_URL` | URL to test proxies against | `https://api.ipify.org?format=json` | No |
| `TEST_INTERVAL_MS` | Milliseconds between proxy tests | `5000` (5 seconds) | No |
| `REQUEST_TIMEOUT_MS` | HTTP request timeout in milliseconds | `30000` (30 seconds) | No |
| `ROTATION_THRESHOLD` | Max attempts with same IP before flagging | `10` | No |
| `PROXY_REFRESH_INTERVAL_MS` | Milliseconds between proxy list refreshes | `21600000` (6 hours) | No |
| `STABILITY_CHECK_INTERVAL_MS` | Milliseconds between stability calculations | `600000` (10 minutes) | No |
| `MIN_RUN_HOURS` | Minimum runtime in hours (fixed mode) | `72` (3 days) | No |
| `RUN_MODE` | Runtime mode: `infinite` or `fixed` | `infinite` | No |
| `MONITOR_CHECK_INTERVAL_MS` | Milliseconds between runtime checks (fixed mode) | `3600000` (1 hour) | No |
| `LOG_LEVEL` | Logging level (`debug`, `info`, `warn`, `error`) | `info` | No |

**Note**: All configuration is validated on startup. Missing required variables will cause the application to exit with an error.

## Database Schema

### Proxies Table

Stores proxy configurations and status:

- `device_id`: Primary key (device ID from XProxy Portal)
- `name`, `location`, `host`, `port`, `protocol`
- `username`, `password`: Proxy credentials
- `active`: Whether proxy is currently active (indexed)
- `last_ip`: Last detected outbound IP
- `same_ip_count`: Consecutive tests with same IP
- `stability_status`: `Stable`, `UnstableHourly`, `UnstableDaily`, `Unknown` (indexed)
- `rotation_status`: `OK`, `NoRotation`, `Unknown` (indexed)
- `last_rotation_at`: Timestamp of last IP rotation
- `rotation_count`: Total number of IP rotations detected
- `created_at`, `updated_at`: Timestamps

### Proxy Requests Table

Stores all test results:

- `id`: UUID primary key
- `proxy_id`: Foreign key to proxies.device_id (indexed with timestamp)
- `timestamp`: Test timestamp (indexed)
- `target_url`: URL that was tested
- `status`: `SUCCESS`, `TIMEOUT`, `CONNECTION_ERROR`, `HTTP_ERROR`, `DNS_ERROR`, `OTHER` (indexed)
- `http_status_code`: HTTP status code (if available)
- `response_time_ms`: Response time in milliseconds
- `expected_ip`: Expected IP from device (device.ip_address)
- `outbound_ip`: Detected outbound IP address (indexed)
- `ip_changed`: Whether IP changed from previous test (indexed)
- `error_type`: Error classification
- `error_message`: Detailed error message

## Stability Criteria

A proxy is classified as:

- **Stable**: No issues detected
- **Unstable (Hourly)**: Down more than 10 minutes within any 1-hour window
- **Unstable (Daily)**: Down more than 1 hour within any 24-hour window

## IP Rotation Detection

- Tracks outbound IP for each proxy test
- Compares current IP with previous IP to detect rotation
- Increments `rotation_count` when IP changes
- Records `last_rotation_at` timestamp when rotation occurs
- Flags proxy as `NoRotation` if IP doesn't change after `ROTATION_THRESHOLD` consecutive tests
- Default threshold: 10 attempts (50 seconds at 5-second intervals)
- Resets rotation status to `OK` when rotation is detected after being flagged

## Monitoring

### View Database

```bash
# Using Prisma Studio (visual database browser)
npm run db:studio

# Or connect directly to MySQL
mysql -u root xproxy_tester
```

### Query Examples

```sql
-- Get proxy stability summary
SELECT 
  stability_status,
  COUNT(*) as count
FROM proxies
WHERE active = true
GROUP BY stability_status;

-- Get recent failures
SELECT 
  p.name,
  pr.timestamp,
  pr.status,
  pr.error_type
FROM proxy_requests pr
JOIN proxies p ON pr.proxy_id = p.id
WHERE pr.status != 'SUCCESS'
ORDER BY pr.timestamp DESC
LIMIT 100;

-- Get proxies with rotation issues
SELECT 
  name,
  last_ip,
  same_ip_count,
  rotation_status
FROM proxies
WHERE rotation_status = 'NoRotation'
  AND active = true;
```

## Architecture

```
src/
├── api/             # XProxy Portal API clients
│   ├── devices.ts          # Device fetching with pagination
│   └── endpoints.ts        # API endpoint constants
├── clients/         # HTTP clients
│   ├── proxyClient.ts      # Proxy request client (undici)
│   └── xproxyClient.ts     # XProxy API client (axios)
├── config/          # Configuration management
│   └── index.ts            # Centralized config with validation
├── helpers/         # Utility functions
│   ├── devices.ts          # Device caching and management
│   └── test-proxy.ts       # Proxy testing helpers
├── lib/             # Core libraries
│   ├── db.ts               # Prisma database client
│   └── logger.ts           # Pino logger configuration
├── services/        # Business logic services
│   ├── continuous-proxy-tester.ts  # Main testing orchestrator
│   └── stability-calculator.ts      # Stability calculation service
├── types/           # TypeScript type definitions
│   └── index.ts            # All type definitions
└── main.ts          # Application entry point
```

## How It Works

1. **Startup**: Application validates configuration and connects to database
2. **Device Fetching**: Fetches all devices from XProxy Portal API (with pagination)
3. **Continuous Testing**: Each device is tested independently:
   - Makes HTTP request through device proxy
   - Waits for response (up to 30 seconds timeout)
   - Waits 5 seconds after completion
   - Repeats continuously
4. **Rotation Detection**: Tracks IP changes and counts rotations
5. **Stability Calculation**: Runs every 10 minutes to calculate proxy stability
6. **Device Refresh**: Refreshes device list every 6 hours
7. **Runtime Management**:
   - **Infinite Mode** (`RUN_MODE=infinite`): Runs indefinitely until manually stopped
   - **Fixed Mode** (`RUN_MODE=fixed`): Runs for at least `MIN_RUN_HOURS` (default: 72 hours), then auto-shuts down
   - In fixed mode, shutdown requests are blocked until minimum runtime is met

## Production Considerations

1. **Security**: Encrypt proxy passwords in database
2. **Scaling**: Consider horizontal scaling with message queues (BullMQ, RabbitMQ)
3. **Monitoring**: Add metrics collection (Prometheus, DataDog)
4. **Alerting**: Set up alerts for critical failures
5. **Backup**: Regular database backups
6. **Rate Limiting**: Respect API rate limits from XProxy Portal
7. **Resource Management**: Monitor memory usage with many concurrent devices

## Troubleshooting

### Database Connection Issues

```bash
# Test MySQL connection
./scripts/test-mysql-connection.sh

# Check MySQL is running
mysql -u root -e "SELECT 1;"

# Verify database exists
mysql -u root -e "SHOW DATABASES LIKE 'xproxy_tester';"

# Reset database schema (WARNING: deletes all data)
npm run db:push -- --force-reset
```

### Application Errors

```bash
# Check configuration
# Application will fail fast if required env vars are missing

# View logs
# Application logs to stdout with structured logging

# Restart application
# Simply stop (Ctrl+C) and restart
```

### Common Issues

- **"Missing required environment variables"**: Check `.env` file exists and has all required variables
- **"Authentication failed"**: Verify MySQL credentials in `DATABASE_URL`
- **"User was denied access"**: Check MySQL user permissions
- **Proxy requests failing**: Verify `relay_server_ip_address` is correct (not `ip_address`)

## License

MIT

