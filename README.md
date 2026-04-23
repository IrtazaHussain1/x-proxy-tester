# XProxy Tester

Automated proxy testing system that continuously evaluates all available proxies from the XProxy Portal, measuring uptime, stability, IP rotation behavior, and real-world usability.

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose (for containerized deployment)
- MySQL (for local development without Docker)

### Using Docker (Recommended)

1. **Clone and setup:**
  ```bash
   git clone <repository-url>
   cd x-proxy-tester
   cp env.example .env
  ```
2. **Configure environment:**
  Edit `.env` and set:
  - `XPROXY_API_TOKEN` - Your XProxy Portal API token
  - `ENCRYPTION_KEY` - Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. **Start services:**
  ```bash
   docker-compose up -d
  ```
4. **Access services:**
  - **Application Health**: [http://localhost:3311/health](http://localhost:3311/health)
  - **Grafana Dashboards**: [http://localhost:3312](http://localhost:3312) (admin/admin)
  - **MySQL**: localhost:3310

### Local Development

1. **Install dependencies:**
  ```bash
   npm install
  ```
2. **Setup database:**
  ```bash
   ./scripts/setup-mysql.sh
   # Or manually: mysql -u root -e "CREATE DATABASE xproxy_tester;"
  ```
3. **Configure environment:**
  ```bash
   cp env.example .env
   # Edit .env with your configuration
  ```
4. **Initialize database:**
  ```bash
   npm run db:generate
   npm run db:push
  ```
5. **Run application:**
  ```bash
   # Development mode (with hot reload)
   npm run dev

   # Production mode
   npm run build
   npm start
  ```

## Development

### Available Scripts

- `npm run dev` - Start in development mode with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Run production build
- `npm test` - Run tests
- `npm run db:studio` - Open Prisma Studio (database GUI)

### Project Structure

```
src/
├── api/              # XProxy Portal API clients
├── clients/          # HTTP clients (proxy, API)
├── config/           # Configuration management
├── helpers/          # Utility functions
├── lib/              # Core libraries (db, logger, metrics)
├── services/         # Business logic (testing, stability)
└── main.ts           # Application entry point
```

### Key Features

- ✅ Continuous proxy testing (every 5 seconds per proxy)
- ✅ IP rotation detection and tracking
- ✅ Stability calculation (Stable/UnstableHourly/UnstableDaily)
- ✅ Comprehensive logging to MySQL
- ✅ Pre-configured Grafana dashboards
- ✅ Health checks and Prometheus metrics
- ✅ Docker deployment ready

## Configuration

Key environment variables (see `.env.example` for full list):

**Core:**

- `DATABASE_URL` - MySQL connection string
- `XPROXY_LOGIN_EMAIL` / `XPROXY_LOGIN_PASSWORD` - XProxy Portal credentials

**Security (Production Required):**

- `ENCRYPTION_KEY` - 64-char hex key for credential encryption (generate: `node -e "require('crypto').randomBytes(32).toString('hex')"`)
- `REDIS_PASSWORD` - Password for Redis auth (highly recommended)
- `API_SECRET_KEY` - Bearer token for management endpoints `/api/testing/start|stop`
- `CORS_ALLOWED_ORIGIN` - Restrict CORS origin (default: `*`)

**Testing & Monitoring:**

- `TEST_INTERVAL_MS` - Time between proxy tests (default: 5000ms)
- `REQUEST_TIMEOUT_MS` - Request timeout (default: 30000ms)
- `ROTATION_THRESHOLD` - Max test attempts before flagging no rotation (default: 10)
- `AGGREGATION_SCHEDULE` - UTC cron schedule for daily aggregation (default: `"0 1"` = 1:00 AM UTC)
- `AGGREGATION_WATCHDOG_MS` - Timeout to release hung aggregation lock (default: 4 hours)

See `.env.example` for complete list with descriptions.

## Monitoring Aggregation Status

The app runs a **daily aggregation job** to summarize the previous day's proxy test results. To verify it's working:

```bash
# Check recent aggregations
mysql> SELECT DATE(day) as date, COUNT(*) FROM proxy_requests_daily_summary
        WHERE day >= DATE_SUB(NOW(), INTERVAL 5 DAY)
        GROUP BY DATE(day) ORDER BY day DESC;

# Check logs
docker logs -f x-proxy-tester-app | grep -i "aggregat"

# Expected: "Starting app-side daily aggregation" and "Stability calculation completed"
```

See `**docs/ARCHITECTURAL_IMPROVEMENTS.md**` for a complete guide to monitoring and the recent system fixes.

## Documentation

- **Architecture (canonical)**: `docs/ARCHITECTURE.md`
- **Operations runbook (canonical)**: `docs/OPERATIONS.md`
- **Grafana setup**: `grafana/README.md`

Legacy and change-log style documents in `docs/` are retained for historical reference, while new updates should be consolidated into the two canonical docs above.

## License

MIT