import {createHmac} from 'node:crypto';

/** Byte source derived from HMAC-SHA256 in counter mode. */
export interface ByteStream {
  next(): number;
}

/**
 * HMAC-SHA256(serverSeed, context || counter) blocks, consumed byte by byte.
 * The counter is a 32-bit big-endian integer starting at zero.
 */
export function createStream(serverSeed: string, context: string): ByteStream {
  const key = Buffer.from(serverSeed, 'hex');
  const contextBytes = Buffer.from(context, 'utf8');
  let block: Buffer = Buffer.alloc(0);
  let offset = 0;
  let counter = 0;
  return {
    next(): number {
      if (offset >= block.length) {
        const counterBytes = Buffer.alloc(4);
        counterBytes.writeUInt32BE(counter, 0);
        counter += 1;
        block = createHmac('sha256', key).update(contextBytes).update(counterBytes).digest();
        offset = 0;
      }
      const byte = block[offset]!;
      offset += 1;
      return byte;
    },
  };
}

/**
 * Unbiased integer in [0, range) via rejection sampling: bytes at or above the
 * largest multiple of range are discarded, so every value stays equiprobable.
 */
export function uniform(stream: ByteStream, range: number): number {
  if (!Number.isInteger(range) || range < 1 || range > 256) {
    throw new RangeError('Uniform range must be an integer from 1 to 256.');
  }
  const limit = Math.floor(256 / range) * range;
  for (;;) {
    const byte = stream.next();
    if (byte < limit) return byte % range;
  }
}
