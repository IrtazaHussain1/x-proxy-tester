#!/bin/bash

# Setup script for MySQL database (local, no Docker)

set -e

echo "🗄️  Setting up MySQL database for XProxy Tester"
echo ""

# Check if MySQL is installed
if ! command -v mysql &> /dev/null; then
  echo "❌ MySQL client not found. Please install MySQL first:"
  echo "   macOS: brew install mysql"
  echo "   Ubuntu: sudo apt-get install mysql-server"
  echo "   Or download from: https://dev.mysql.com/downloads/mysql/"
  exit 1
fi

echo "✅ MySQL client found"
echo ""

# Prompt for MySQL credentials
read -p "Enter MySQL username (default: root): " MYSQL_USER
MYSQL_USER=${MYSQL_USER:-root}

read -sp "Enter MySQL password: " MYSQL_PASSWORD
echo ""

read -p "Enter MySQL host (default: 127.0.0.1): " MYSQL_HOST
MYSQL_HOST=${MYSQL_HOST:-127.0.0.1}

read -p "Enter MySQL port (default: 3306): " MYSQL_PORT
MYSQL_PORT=${MYSQL_PORT:-3306}

DB_NAME="xproxy_tester"

echo ""
echo "📦 Creating database '${DB_NAME}'..."

# Create database
mysql -h${MYSQL_HOST} -P${MYSQL_PORT} -u${MYSQL_USER} -p${MYSQL_PASSWORD} <<EOF
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ${DB_NAME};
SELECT 'Database ${DB_NAME} created successfully!' AS message;
EOF

if [ $? -eq 0 ]; then
  echo "✅ Database '${DB_NAME}' created successfully!"
  echo ""
  echo "📝 Update your .env file with:"
  echo "   DATABASE_URL=\"mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${DB_NAME}\""
  echo ""
  echo "Next steps:"
  echo "  1. Update .env with the DATABASE_URL above"
  echo "  2. Run: npm run db:generate"
  echo "  3. Run: npm run db:push"
else
  echo "❌ Failed to create database. Please check your MySQL credentials."
  exit 1
fi

