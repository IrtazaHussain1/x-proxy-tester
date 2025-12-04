import { getDevices, getDevicesWithMetadata } from '../api/devices';
import type { Device } from '../types';

const PAGE_SIZE = 50;
let _allDevices: Device[] = [];

/**
 * Calculate the number of pages needed based on total count and page size
 * @param total - Total number of items
 * @param pageSize - Number of items per page
 * @returns Number of pages (rounded up)
 */
function calculateTotalPages(total: number, pageSize: number): number {
  return Math.ceil(total / pageSize);
}

/**
 * Fetch all devices across all pages
 * Uses page size of 50 and fetches all pages in parallel
 * @returns Array of all device objects
 */
export async function fetchAllDevices(): Promise<Device[]> {
  // First, fetch the first page with metadata to get total count
  const firstPageData = await getDevicesWithMetadata({
    offset: 0,
    limit: PAGE_SIZE,
    total_count: true,
    count_by_status: true,
  });

  const total = firstPageData.total;
  const totalPages = calculateTotalPages(total, PAGE_SIZE);

  // If only one page, return the devices from first page
  if (totalPages <= 1) {
    return firstPageData.devices;
  }

  // Fetch remaining pages in parallel
  const pagePromises: Promise<Device[]>[] = [];

  // Start from page 2 (index 1) since we already have page 1
  for (let page = 1; page < totalPages; page++) {
    const offset = page * PAGE_SIZE;
    pagePromises.push(
      getDevices({
        offset,
        limit: PAGE_SIZE,
      })
    );
  }

  // Wait for all pages to be fetched
  const remainingPages = await Promise.all(pagePromises);

  // Combine all devices: first page + remaining pages
  const allDevices = [...firstPageData.devices, ...remainingPages.flat()];

  _allDevices = allDevices;

  return allDevices;
}

export async function getAllDevices(): Promise<Device[]> {
  if (_allDevices.length > 0) {
    return _allDevices;
  } else return fetchAllDevices();
}
export const updateDevices = fetchAllDevices;
