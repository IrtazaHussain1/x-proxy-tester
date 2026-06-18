/**
 * API Endpoint Constants
 * URL path constants for XProxy Portal API endpoints.
 */
// Endpoint for fetching device list from XProxy Portal
// Note: no leading slash — Axios appends to baseURL path rather than replacing it
export const DEVICES_ENDPOINT = 'devices';
// Endpoint for sending commands (e.g., IP rotation) to devices
// Note: no leading slash — Axios appends to baseURL path rather than replacing it
export const COMMANDS_ENDPOINT = 'commands';

