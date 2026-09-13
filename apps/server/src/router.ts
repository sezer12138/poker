import type {IncomingMessage, ServerResponse} from 'node:http';
import {AppError} from './errors.ts';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** Exact-segment router: `/api/rooms/:id/command`, no regex and no ambiguity. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(segment => segment !== ''),
      handler,
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    const parts = url.pathname.split('/').filter(segment => segment !== '');
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index++) {
        const pattern = route.segments[index]!;
        const value = parts[index]!;
        if (pattern.startsWith(':')) {
          if (value === '') {
            matched = false;
            break;
          }
          // 百分号编码畸形（如 /api/rooms/%zz）必须回 400，而不是把 URIError
          // 冒到统一的 500 分支去打一整条堆栈日志。
          try {
            params[pattern.slice(1)] = decodeURIComponent(value);
          } catch {
            throw new AppError('INVALID_INPUT', '请求地址不合法');
          }
        } else if (pattern !== value) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      await route.handler({req, res, url, params});
      return true;
    }
    return false;
  }
}
