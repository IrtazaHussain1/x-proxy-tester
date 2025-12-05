# Multi-stage build for XProxy Tester
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

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

# Install production dependencies
# Note: Prisma CLI will be available via npx from node_modules
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
# Copy Prisma package and CLI (needed for db push)
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
# Copy Grafana views SQL file
COPY --from=builder --chown=nodejs:nodejs /app/grafana-views.sql ./grafana-views.sql

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

