#!/bin/bash

# Test MySQL connection and help configure .env

echo "🔍 Testing MySQL connection..."
echo ""

# Try different common configurations
# Using 127.0.0.1 instead of localhost to force TCP/IP connection (avoids socket issues on macOS)
CONFIGS=(
  "root:root@127.0.0.1:3306"
  "root:@127.0.0.1:3306"
  "root:password@127.0.0.1:3306"
  "root:mysql@127.0.0.1:3306"
)

for config in "${CONFIGS[@]}"; do
  IFS=':' read -r user pass <<< "$config"
  IFS='@' read -r pass host <<< "$pass"
  IFS=':' read -r host port <<< "$host"
  
  if [ -z "$pass" ]; then
    echo "Testing: mysql -u $user (no password) -h $host -P $port"
    if mysql -u "$user" -h "$host" -P "$port" -e "SELECT 1;" > /dev/null 2>&1; then
      echo "✅ SUCCESS! Use this in .env:"
      echo "   DATABASE_URL=\"mysql://$user@$host:$port/xproxy_tester\""
      exit 0
    fi
  else
    echo "Testing: mysql -u $user -p$pass -h $host -P $port"
    if mysql -u "$user" -p"$pass" -h "$host" -P "$port" -e "SELECT 1;" > /dev/null 2>&1; then
      echo "✅ SUCCESS! Use this in .env:"
      echo "   DATABASE_URL=\"mysql://$user:$pass@$host:$port/xproxy_tester\""
      exit 0
    fi
  fi
done

echo "❌ Could not connect with common configurations"
echo ""
echo "Please provide your MySQL credentials:"
read -p "MySQL username (default: root): " MYSQL_USER
MYSQL_USER=${MYSQL_USER:-root}

read -sp "MySQL password: " MYSQL_PASS
echo ""

read -p "MySQL host (default: 127.0.0.1): " MYSQL_HOST
MYSQL_HOST=${MYSQL_HOST:-127.0.0.1}

read -p "MySQL port (default: 3306): " MYSQL_PORT
MYSQL_PORT=${MYSQL_PORT:-3306}

echo ""
echo "Testing connection..."
if mysql -u "$MYSQL_USER" -p"$MYSQL_PASS" -h "$MYSQL_HOST" -P "$MYSQL_PORT" -e "SELECT 1;" > /dev/null 2>&1; then
  echo "✅ Connection successful!"
  echo ""
  echo "Update your .env file with:"
  echo "DATABASE_URL=\"mysql://$MYSQL_USER:$MYSQL_PASS@$MYSQL_HOST:$MYSQL_PORT/xproxy_tester\""
else
  echo "❌ Connection failed. Please check:"
  echo "   1. MySQL is running"
  echo "   2. Credentials are correct"
  echo "   3. User has proper permissions"
fi

