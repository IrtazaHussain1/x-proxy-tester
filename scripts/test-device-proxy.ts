import { prisma } from "../src/lib/db";
import { testProxyWithStats, formatProxyTestStats } from "../src/helpers/test-proxy";
import { config as dotenvConfig } from "dotenv";
import type { Device } from "../src/types";

dotenvConfig({ path: '.env' });

// Retrieve device ID from command line arguments
const args = process.argv.slice(2);
const deviceId = args[0] ? args[0] : null;

if (!deviceId) {
  console.error("Please provide a valid device ID as an argument.");
  console.error("Usage: npx tsx scripts/test-device-proxy.ts <DEVICE_ID>");
  process.exit(1);
}

console.log(`Starting proxy test for device ID: ${deviceId}`);

async function main() {
  try {
    // Get device from database
    const proxy = await prisma.proxy.findFirst({
      where: { 
        deviceApiId: 54,
       },
    });

    if (!proxy) {
      console.error(`Device with ID ${deviceId} not found in database.`);
      process.exit(1);
    }

    console.log(`Found device: ${proxy.name} (${proxy.deviceId}) - ${proxy.host}:${proxy.port}`);

    // Map Prisma Proxy model to Device interface
    const device: Device = {
      id: proxy.deviceApiId || 0,
      device_id: proxy.deviceId,
      name: proxy.name,
      model: proxy.model || '',
      ip_address: proxy.ipAddress || '',
      port: proxy.port,
      ws_status: proxy.wsStatus || '',
      proxy_status: proxy.proxyStatus || '',
      country: proxy.country || '',
      state: proxy.state || '',
      city: proxy.city || '',
      location: proxy.location || '',
      street: proxy.street || '',
      longitude: proxy.longitude || 0,
      latitude: proxy.latitude || 0,
      relay_server_id: proxy.relayServerId || 0,
      download_net_speed: proxy.downloadNetSpeed,
      upload_net_speed: proxy.uploadNetSpeed,
      last_ip_rotation: proxy.lastIpRotation || '',
      username: proxy.username || '',
      password: proxy.password || '',
      extra: proxy.extra || undefined,
      created_at: proxy.createdAt.toISOString(),
      updated_at: proxy.updatedAt.toISOString(),
      relay_server_ip_address: proxy.relayServerIpAddress || proxy.host,
    };

    console.log('Starting proxy test...');
    const result = await testProxyWithStats(device);

    console.log('\n--- Test Results ---');
    console.log('Primary:', formatProxyTestStats(result.primary, device.ip_address));
    
    if (result.secondary) {
        console.log('Secondary:', formatProxyTestStats(result.secondary));
    }

  } catch (error) {
    console.error("Error during test:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
