import type {IncomingMessage, ServerResponse} from 'node:http';
import {AppError, toAppError} from './errors.ts';
import {BODY_LIMIT_BYTES} from './config.ts';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: unknown): void {
  const appError = toAppError(error);
  if (appError.code === 'INTERNAL') console.error('[server] 未预期的错误', error);
  sendJson(res, appError.status, {error: {code: appError.code, message: appError.message}});
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, {'content-length': 0});
  res.end();
}

/** Reads a JSON body with a hard size cap; rejects anything else before parsing. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new AppError('INVALID_INPUT', '请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_INPUT', '请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INVALID_INPUT', '请求体必须是对象');
  }
  return parsed as Record<string, unknown>;
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{16,200})$/.exec(header.trim());
  return match ? match[1]! : null;
}

export function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}
