import {uniform, type ByteStream} from './stream.ts';

/** Fisher–Yates driven entirely by the byte stream; the input array is untouched. */
export function shuffle<T>(items: readonly T[], stream: ByteStream): T[] {
  const out = [...items];
  for (let i = 0; i < out.length - 1; i++) {
    const j = i + uniform(stream, out.length - i);
    const swap = out[i]!;
    out[i] = out[j]!;
    out[j] = swap;
  }
  return out;
}
