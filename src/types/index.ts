// All type definitions for the application

export interface XProxyPhone {
  phoneId: string;
  name: string;
  location?: string;
  host: string;
  port: number;
  protocol?: string;
  username?: string;
  password?: string;
}

export interface XProxyApiResponse {
  phones?: XProxyPhone[];
  data?: XProxyPhone[];
  // Handle case where response is directly an array
  [key: string]: any;
}

export type StabilityStatus = 'Unknown' | 'Stable' | 'UnstableHourly' | 'UnstableDaily';
export type RotationStatus = 'OK' | 'NoRotation' | 'Unknown';
export type RequestStatus = 'SUCCESS' | 'TIMEOUT' | 'CONNECTION_ERROR' | 'HTTP_ERROR' | 'DNS_ERROR' | 'OTHER';
export type ErrorType = 'TIMEOUT' | 'CONNECTION_REFUSED' | 'CONNECTION_RESET' | 'DNS_ERROR' | 'HTTP_ERROR' | 'TLS_ERROR' | 'OTHER';

export interface ProxyTestResult {
  success: boolean;
  httpStatus?: number;
  responseTimeMs: number;
  body?: any;
  errorType?: ErrorType;
  errorMessage?: string;
}

export interface ProxyMetrics {
  requestUrl: string;
  proxyHost: string;
  proxyPort: number;
  responseTimeMs: number;
  httpStatus?: number;
  success: boolean;
  outboundIp?: string;
  errorType?: ErrorType;
  errorMessage?: string;
  timestamp: Date;
}

// Device-related types
export interface Device {
  id: number;
  device_id: string;
  name: string;
  model: string;
  ip_address: string;
  port: number;
  ws_status: string;
  proxy_status: string;
  country: string;
  state: string;
  city: string;
  street: string;
  longitude: number;
  latitude: number;
  relay_server_id: number;
  download_net_speed: number | null;
  upload_net_speed: number | null;
  last_ip_rotation: string;
  username: string;
  password: string;
  created_at: string;
  updated_at: string;
  relay_server_ip_address: string;
}

export interface DevicesResponse {
  data: {
    devices: Device[];
    total: number;
    active: number;
    inactive: number;
    in_maintenance: number;
    total_increase_percent: number;
    active_increase_percent: number;
    inactive_increase_percent: number;
  };
}

export interface DeviceLocation {
  location: string;
  deviceCount?: number;
  devices?: Device[];
}

/**
 * Available command types for device actions
 */
export enum CommandType {
  AIRPLANE_MODE_ROTATE = 'airplane_mode_rotate',
  AIRPLANE_MODE_ROTATE_UNIQUE = 'airplane_mode_rotate_unique',
}

export interface CommandRequest {
  deviceId?: string;
  action: string | CommandType;
  params?: Record<string, any>;
}

export interface CommandResponse {
  success: boolean;
  message?: string;
  data?: any;
}

