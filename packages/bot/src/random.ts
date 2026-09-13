/**
 * Default randomness: the platform CSPRNG, never Math.random. The server injects
 * a deterministic source in tests, and this default keeps play unpredictable.
 */
export function secureRandom(): number {
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0]! / 4294967296;
}
