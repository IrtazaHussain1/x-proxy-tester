/**
 * Derives rack/server bucket labels (e.g. S7, S32) from XProxy device display names.
 *
 * Names arrive from a third-party API and are often dirty: the rack token can be
 * glued onto a phone model (`samsung_SM-G981BS37 P22`) or missing its `P` (`S39 29`).
 * We therefore look for the rack token `S##` immediately followed by `P##` ANYWHERE
 * in the name. The mandatory `P##` suffix is what distinguishes a real rack from a
 * model number — e.g. `SM-S908U` (Galaxy S22) has no `P##`, so it stays UNKNOWN
 * instead of being mis-read as server `S90`.
 */

/** Primary: rack token `S##` + optional separator + `P##`, anywhere in the string. */
const RACK_WITH_PORT = /S(\d{1,3})[\s_-]*P\d+/i;

/** Secondary: a name that starts with `S## ##` but dropped the `P` (e.g. `S39 29`). */
const RACK_MISSING_PORT = /^S(\d{1,3})[\s_-]+\d+/i;

/**
 * Returns a short server label such as `S10` or `UNKNOWN`.
 */
export function computeServerLabelFromDeviceName(deviceName: string | null | undefined): string {
  if (deviceName == null) {
    return 'UNKNOWN';
  }
  const s = String(deviceName).trim();
  if (s === '') {
    return 'UNKNOWN';
  }

  const withPort = s.match(RACK_WITH_PORT);
  if (withPort) {
    return `S${withPort[1]}`;
  }

  const missingPort = s.match(RACK_MISSING_PORT);
  if (missingPort) {
    return `S${missingPort[1]}`;
  }

  return 'UNKNOWN';
}
