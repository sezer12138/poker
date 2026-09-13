import {createHash} from 'node:crypto';

export const HEX64 = /^[0-9a-f]{64}$/;
export const ZERO_NONCE = '0'.repeat(64);
export const VERSION = 'hmac-sha256-fy-v1';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}

/** Deterministic encoding: array order is preserved, object keys are sorted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}
