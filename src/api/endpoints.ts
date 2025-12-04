/**
 * API Endpoint Constants
 * 
 * URL path constants for XProxy Portal API endpoints.
 * Base URL is determined by XPROXY_API_URL environment variable.
 * 
 * @module api/endpoints
 */

/**
 * Devices endpoint - used for fetching device list
 * Full URL: {XPROXY_API_URL}/devices
 */
export const DEVICES_ENDPOINT = '/devices';

/**
 * Endpoint for device locations
 * Full URL: BASE/devices/location
 */
export const DEVICES_LOCATION_ENDPOINT = '/devices/location';

/**
 * Endpoint for commands
 * Full URL: BASE/commands
 */
export const COMMANDS_ENDPOINT = '/commands';

