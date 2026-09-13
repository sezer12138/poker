import {readFile, stat} from 'node:fs/promises';
import {extname, join, normalize, resolve, sep} from 'node:path';
import type {RouteHandler} from './router.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const CACHEABLE = new Set(['.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.ico']);

/**
 * Serves the browser client from disk. Paths are resolved and then re-checked so
 * a crafted URL can never escape the web root.
 */
export function createStaticHandler(options: {root: string; index?: string}): RouteHandler {
  const root = resolve(options.root);
  const index = options.index ?? 'index.html';

  return async ({req, res, url}) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {'content-length': 0});
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, {'content-length': 0});
      res.end();
      return;
    }
    if (pathname.includes('\0')) {
      res.writeHead(400, {'content-length': 0});
      res.end();
      return;
    }
    const relative = normalize(pathname).replace(/^([/\\])+/, '');
    let target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403, {'content-length': 0});
      res.end();
      return;
    }
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory() === true) target = join(target, index);
    const body = await readFile(target).catch(() => null);
    if (body === null) {
      const text = '未找到该页面';
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text)});
      res.end(text);
      return;
    }
    const extension = extname(target).toLowerCase();
    const headers: Record<string, string> = {
      'content-type': TYPES[extension] ?? 'application/octet-stream',
      'content-length': String(body.length),
      'cache-control': CACHEABLE.has(extension) ? 'public, max-age=300' : 'no-cache',
      'x-content-type-options': 'nosniff',
      // 'self' covers same-origin ws:// and wss:// connections in CSP3.
      'content-security-policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
