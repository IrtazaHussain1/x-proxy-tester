/**
 * Derives rack/server bucket labels (e.g. S7, S32) from XProxy device display names.
 * A server is present only when the name starts with rack id `S` + digits and then one of:
 * `P…` (SXXP…), space/underscore/hyphen + `P…` (SXX P…, SXX_P…). Anything else → UNKNOWN.
 */

/** After `S##`, only `P` + slot digits count (no `P` → no server). */
const RACK_TAIL = /^(?:P\d+|[\s_-]+P\d+)/i;

const LEADING_PORT = /^PORT\s+\d+\s+/i;

/**
 * Returns a short server label such as `S10` or `UNKNOWN`.
 */
export function computeServerLabelFromDeviceName(deviceName: string | null | undefined): string {
  if (deviceName == null) {
    return 'UNKNOWN';
  }
  let s = String(deviceName).trim();
  if (s === '') {
    return 'UNKNOWN';
  }

  s = s.replace(LEADING_PORT, '');
  const upper = s.toUpperCase();

  if (/^[_]/.test(upper)) {
    return 'UNKNOWN';
  }

  const m = upper.match(/^S(\d{1,3})/);
  if (!m) {
    return 'UNKNOWN';
  }

  const rest = upper.slice(m[0].length);
  if (!RACK_TAIL.test(rest)) {
    return 'UNKNOWN';
  }

  return `S${m[1]}`;
}
