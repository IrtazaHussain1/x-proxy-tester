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

# Generate Prisma Client
RUN npm run db:generate

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install git temporarily for npm (needed for git-based packages)
# Then install production dependencies and remove git to keep image small
RUN apk add --no-cache git && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    apk del git

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
# Note: We do NOT need to copy node_modules manually anymore because we did npm ci above.
# However, we MUST copy the generated client from builder if you generated it there, 
# OR just regenerate it here. Copying is usually faster:
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

COPY --from=builder --chown=nodejs:nodejs /app/grafana-views.sql ./grafana-views.sql
COPY --from=builder --chown=nodejs:nodejs /app/grafana-views-optimized.sql ./grafana-views-optimized.sql

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

