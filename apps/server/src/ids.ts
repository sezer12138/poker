import {randomBytes, randomUUID} from 'node:crypto';

/** No 0/O/1/I/L: room codes are read aloud and typed by hand. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function uuid(): string {
  return randomUUID();
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function roomCode(): string {
  const raw = randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[raw[i]! % CODE_ALPHABET.length]!;
  return code;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Uniform float in [0, 1) from the OS CSPRNG.
 * 机器人决策需要「随机」，但 src/ 里禁止 Math.random，这里给一个可注入的替身。
 */
export function randomFloat(): number {
  return randomBytes(4).readUInt32BE(0) / 2 ** 32;
}
