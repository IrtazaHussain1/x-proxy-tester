#!/usr/bin/env tsx
/**
 * Sync Device Fields from XProxy API
 * 
 * This script syncs all device fields from the XProxy API dashboard to the local database.
 * It updates existing proxies and creates new ones if they don't exist.
 * 
 * Usage:
 *   npx tsx scripts/sync-device-fields-from-api.ts
 */

import { getAllDevices } from '../src/helpers/devices';
import { prisma } from '../src/lib/db';
import { logger } from '../src/lib/logger';
import { mapProxyStatusToActive } from '../src/services/continuous-proxy-tester';
import { extractAppVersion } from '../src/helpers/extra-parser';

async function syncDeviceFieldsFromApi(): Promise<void> {
  logger.info('Starting device fields sync from XProxy API');

  try {
    // Fetch all devices from API
    const devices = await getAllDevices();
    logger.info({ deviceCount: devices.length }, 'Fetched devices from API');

    if (devices.length === 0) {
      logger.warn('No devices found in API response');
      return;
    }

    let created = 0;
    let updated = 0;
    let errors = 0;

    // Process each device
    for (const device of devices) {
      try {
        const isActive = mapProxyStatusToActive(device.proxy_status);
        
        // Check if proxy exists
        const existing = await prisma.proxy.findUnique({
          where: { deviceId: device.device_id },
        });

        const deviceData = {
          deviceApiId: device.id || null,
          name: device.name,
          model: device.model || null,
          location: device.state || device.city || null,
          host: device.relay_server_ip_address,
          port: device.port,
          protocol: 'http',
          username: device.username,
          password: device.password || null,
          active: isActive,
          ipAddress: device.ip_address || null,
          wsStatus: device.ws_status || null,
          proxyStatus: device.proxy_status || null,
          country: device.country || null,
          state: device.state || null,
          city: device.city || null,
          street: device.street || null,
          longitude: device.longitude || null,
          latitude: device.latitude || null,
          relayServerId: device.relay_server_id || null,
          relayServerIpAddress: device.relay_server_ip_address || null,
          downloadNetSpeed: device.download_net_speed || null,
          uploadNetSpeed: device.upload_net_speed || null,
          lastIpRotation: device.last_ip_rotation || null,
          extra: device.extra || null,
          version: extractAppVersion(device.extra),
        };

        if (existing) {
          // Update existing proxy
          await prisma.proxy.update({
            where: { deviceId: device.device_id },
            data: deviceData,
          });
          updated++;
        } else {
          // Create new proxy
          await prisma.proxy.create({
            data: {
              ...deviceData,
              deviceId: device.device_id,
              lastIp: null,
              sameIpCount: 0,
              rotationStatus: 'Unknown',
              lastRotationAt: null,
              rotationCount: 0,
            },
          });
          created++;
        }

        if ((created + updated) % 50 === 0) {
          logger.info(
            { created, updated, total: created + updated },
            'Progress: syncing device fields'
          );
        }
      } catch (error) {
        errors++;
        logger.error(
          {
            deviceId: device.device_id,
            deviceName: device.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to sync device fields'
        );
      }
    }

    logger.info(
      {
        total: devices.length,
        created,
        updated,
        errors,
      },
      'Device fields sync completed'
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to sync device fields from API'
    );
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the sync
void syncDeviceFieldsFromApi();
