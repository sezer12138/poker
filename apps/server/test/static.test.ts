import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import type {IncomingHttpHeaders} from 'node:http';
import {startTestServer} from './helpers.ts';
import type {TestServer} from './helpers.ts';

interface RawResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * Sends the path exactly as given. `fetch` would collapse a `..` before the
 * server ever sees it, which is the opposite of what these tests are about.
 */
function rawRequest(port: number, path: string, method = 'GET'): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, path, method}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body}));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('静态资源服务', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  it('首页是浏览器客户端，带着安全响应头', async () => {
    const page = await rawRequest(server.port, '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-cache', '入口页必须每次回源');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const csp = String(page.headers['content-security-policy'] ?? '');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self'/, '浏览器要用同源 ws:// 连服务端');
    assert.match(page.body, /<html/i);
    assert.match(page.body, /同桌/, '首页应该是这个产品自己的页面');
  });

  it('静态资源按类型给出 Content-Type 与缓存', async () => {
    const css = await rawRequest(server.port, '/static/styles.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(css.headers['cache-control'], 'public, max-age=300');
    assert.ok(Number(css.headers['content-length']) > 0);
    assert.equal(Buffer.byteLength(css.body, 'utf8'), Number(css.headers['content-length']));

    const script = await rawRequest(server.port, '/static/js/api.js');
    assert.equal(script.status, 200);
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(script.headers['cache-control'], 'public, max-age=300');
  });

  it('内置行动语音可以通过同源 HTTP 播放', async () => {
    const clip = await rawRequest(server.port, '/static/audio/call.mp3', 'HEAD');
    assert.equal(clip.status, 200);
    assert.equal(clip.headers['content-type'], 'audio/mpeg');
    assert.ok(Number(clip.headers['content-length']) > 1000);
  });

  it('HEAD 只给响应头，查询串不影响命中', async () => {
    const head = await rawRequest(server.port, '/index.html', 'HEAD');
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers['content-length']) > 0);
    assert.equal(head.body, '');

    const query = await rawRequest(server.port, '/index.html?v=2');
    assert.equal(query.status, 200);
    assert.match(query.body, /<html/i);
  });

  it('写方法一律 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await rawRequest(server.port, '/index.html', method);
      assert.equal(response.status, 405, method);
      assert.equal(response.body, '');
    }
  });

  it('找不到的页面给中文 404，接口给 JSON 404', async () => {
    const page = await rawRequest(server.port, '/nope.html');
    assert.equal(page.status, 404);
    assert.equal(page.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(page.body, '未找到该页面');

    const api = await rawRequest(server.port, '/api/nope');
    assert.equal(api.status, 404);
    assert.equal(JSON.parse(api.body).error.code, 'NOT_FOUND');
    assert.match(JSON.parse(api.body).error.message, /接口不存在/);
  });

  it('目录穿越拿不到 web 根之外的文件', async () => {
    const attempts = [
      '/../package.json',
      '/../../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/package.json',
      '/static/../../package.json',
      '/static/../../../etc/passwd',
      '/....//....//package.json',
      '/static/js/../../../package.json',
    ];
    for (const path of attempts) {
      const response = await rawRequest(server.port, path);
      assert.ok(
        response.status === 403 || response.status === 404,
        `${path} 应当被挡下，实际 ${response.status}`,
      );
      assert.equal(response.body.includes('"name": "poker"'), false, path);
      assert.equal(response.body.includes('node_modules'), false, path);
    }
  });

  it('畸形路径直接 400', async () => {
    for (const path of ['/%', '/index.html%zz', '/a%00b.txt']) {
      const response = await rawRequest(server.port, path);
      assert.equal(response.status, 400, path);
    }
  });
});
