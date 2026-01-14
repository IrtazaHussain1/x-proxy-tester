# Multi-stage build for XProxy Tester
FROM node:20-alpine AS builder

# Install build dependencies (including git for npm packages from git repos)
RUN apk add --no-cache python3 make g++ git openssl dumb-init

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma Client with retry logic for network issues
# Retries up to 5 times with exponential backoff (3s, 6s, 9s, 12s, 15s)
RUN for i in 1 2 3 4 5; do \
      echo "Prisma generate attempt $i/5..."; \
      if npm run db:generate; then \
        echo "Prisma generate succeeded!"; \
        break; \
      else \
        if [ $i -eq 5 ]; then \
          echo "ERROR: Prisma Client generation failed after 5 attempts"; \
          exit 1; \
        fi; \
        echo "Prisma generate attempt $i failed, waiting before retry..."; \
        sleep $((i * 3)); \
      fi; \
    done

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install runtime dependencies (including mariadb-client for init scripts)
# Use retry logic for network resilience
RUN set -e; \
    for i in 1 2 3; do \
      echo "Package install attempt $i/3..."; \
      if apk update --no-cache && apk add --no-cache dumb-init mariadb-client; then \
        echo "Packages installed successfully"; \
        break; \
      else \
        if [ $i -eq 3 ]; then \
          echo "ERROR: Failed to install packages after 3 attempts"; \
          exit 1; \
        fi; \
        echo "Package install attempt $i failed, waiting before retry..."; \
        sleep $((i * 3)); \
      fi; \
    done

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies
# Note: git is not needed since all dependencies are from npm registry (no git-based packages in package.json)
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
# Note: We do NOT need to copy node_modules manually anymore because we did npm ci above.
# However, we MUST copy the generated client from builder if you generated it there, 
# OR just regenerate it here. Copying is usually faster:
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

COPY --from=builder --chown=nodejs:nodejs /app/grafana-views.sql ./grafana-views.sql
COPY --from=builder --chown=nodejs:nodejs /app/grafana-views-optimized.sql ./grafana-views-optimized.sql
COPY --from=builder --chown=nodejs:nodejs /app/scripts/run-grafana-init.sh ./scripts/run-grafana-init.sh

# Make script executable (before switching to nodejs user)
RUN chmod +x ./scripts/run-grafana-init.sh

# Switch to non-root user
USER nodejs

# Expose health check port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "dist/main.js"]

