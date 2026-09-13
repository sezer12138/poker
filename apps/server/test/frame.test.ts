import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {connect} from 'node:net';
import type {Socket} from 'node:net';
import {once} from 'node:events';
import {readyRoom, startTestServer} from './helpers.ts';
import type {TestServer} from './helpers.ts';
import {OPCODE, acceptKey, encodeClose, encodeFrame, encodeText} from '../src/ws.ts';
import {WS_MESSAGE_LIMIT_BYTES} from '../src/config.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A client frame exactly as RFC 6455 requires the client side to send it. */
function clientFrame(
  opcode: number,
  payload: Buffer,
  options: {fin?: boolean; rsv?: number; mask?: boolean} = {},
): Buffer {
  const fin = options.fin ?? true;
  const masked = options.mask ?? true;
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (options.rsv ?? 0) | opcode;
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4);
  header[1] = (header[1] ?? 0) | 0x80;
  const body = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) body[index] = payload[index]! ^ mask[index & 3]!;
  return Buffer.concat([header, mask, body]);
}

function clientText(text: string, options: {fin?: boolean} = {}): Buffer {
  return clientFrame(OPCODE.text, Buffer.from(text, 'utf8'), options);
}

interface RawFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * The wire as a raw TCP peer sees it: HTTP upgrade, then unmasked server frames.
 * Deliberately not the browser WebSocket API — these tests are about the bytes.
 */
class RawClient {
  socket: Socket;
  frames: RawFrame[] = [];
  status = 0;
  headers = new Map<string, string>();
  ended = false;
  private buffer = Buffer.alloc(0);
  private headerText = '';
  private headerReady = false;
  private resolveHeaders!: () => void;
  readonly handshake: Promise<void>;

  constructor(socket: Socket) {
    this.socket = socket;
    this.handshake = new Promise<void>(resolve => {
      this.resolveHeaders = resolve;
    });
    socket.on('data', chunk => this.push(chunk));
    socket.on('end', () => {
      this.ended = true;
    });
    socket.on('close', () => {
      this.ended = true;
    });
    // The server hangs up on protocol errors; an RST here is the expected outcome,
    // not a test failure, so the socket never throws into the runner.
    socket.on('error', () => {
      this.ended = true;
    });
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.headerReady) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      this.headerText = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4);
      const [statusLine = '', ...lines] = this.headerText.split('\r\n');
      this.status = Number(statusLine.split(' ')[1] ?? 0);
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) this.headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }
      this.headerReady = true;
      this.resolveHeaders();
      if (this.status !== 101) return;
    }
    this.decode();
  }

  /** Server-to-client frames are never masked. */
  private decode(): void {
    for (;;) {
      const buffer = this.buffer;
      if (buffer.length < 2) return;
      const opcode = buffer[0]! & 0x0f;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      this.frames.push({opcode, payload: buffer.subarray(offset, offset + length)});
      this.buffer = buffer.subarray(offset + length);
      if (opcode === OPCODE.close) this.ended = true;
    }
  }

  texts(): string[] {
    return this.frames.filter(frame => frame.opcode === OPCODE.text).map(frame => frame.payload.toString('utf8'));
  }

  messages(): any[] {
    return this.texts().map(text => JSON.parse(text));
  }

  closeFrames(): RawFrame[] {
    return this.frames.filter(frame => frame.opcode === OPCODE.close);
  }

  pings(): RawFrame[] {
    return this.frames.filter(frame => frame.opcode === OPCODE.ping);
  }

  send(frame: Buffer): void {
    this.socket.write(frame);
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Waits on real I/O, which is exactly what a raw socket test cannot fake. */
async function until(done: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}

interface HandshakeOptions {
  key?: string;
  version?: string;
  path?: string;
  method?: string;
  origin?: string;
  /** Bytes written in the same packet as the request, as a browser may do. */
  extra?: Buffer;
}

/** Opens a raw TCP connection and speaks the upgrade by hand. */
async function rawConnect(port: number, options: HandshakeOptions = {}): Promise<RawClient> {
  const socket = connect({host: '127.0.0.1', port});
  await once(socket, 'connect');
  const key = options.key ?? randomBytes(16).toString('base64');
  const request =
    `${options.method ?? 'GET'} ${options.path ?? '/ws'} HTTP/1.1\r\n` +
    'Host: 127.0.0.1\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: ${options.version ?? '13'}\r\n` +
    (options.origin === undefined ? '' : `Origin: ${options.origin}\r\n`) +
    '\r\n';
  const client = new RawClient(socket);
  socket.write(options.extra ? Buffer.concat([Buffer.from(request, 'utf8'), options.extra]) : request);
  await client.handshake;
  return client;
}

describe('WebSocket 帧协议', () => {
  let server: TestServer;
  let roomId: string;
  let token: string;
  let userId: string;

  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
    const room = await readyRoom(server);
    roomId = room.roomId;
    token = room.host.token;
    userId = room.host.user.id;
  });
  after(async () => {
    await server.close();
  });

  function subscribeFrame(overrides: Record<string, unknown> = {}): Buffer {
    return clientText(JSON.stringify({type: 'subscribe', token, roomId, ...overrides}));
  }

  it('握手返回正确的 Sec-WebSocket-Accept，且不协商扩展', async () => {
    const key = randomBytes(16).toString('base64');
    const client = await rawConnect(server.port, {key});
    try {
      assert.equal(client.status, 101);
      assert.equal(client.headers.get('upgrade'), 'websocket');
      assert.equal(client.headers.get('connection'), 'Upgrade');
      assert.equal(client.headers.get('sec-websocket-accept'), acceptKey(key));
      assert.equal(
        acceptKey(key),
        createHash('sha1')
          .update(`${key}${GUID}`)
          .digest('base64'),
        '必须符合 RFC 6455 的固定算法',
      );
      assert.equal(client.headers.has('sec-websocket-extensions'), false, '不协商 permessage-deflate');
    } finally {
      client.close();
    }
  });

  it('握手不对的请求被拒绝', async () => {
    const wrongVersion = await rawConnect(server.port, {version: '12'});
    try {
      assert.equal(wrongVersion.status, 426);
    } finally {
      wrongVersion.close();
    }

    const wrongPath = await rawConnect(server.port, {path: '/api/health'});
    try {
      assert.equal(wrongPath.status, 404);
    } finally {
      wrongPath.close();
    }

    // A key that does not decode to 16 bytes cannot be answered.
    const shortKey = await rawConnect(server.port, {key: 'short'});
    try {
      assert.equal(shortKey.status, 400);
    } finally {
      shortKey.close();
    }

    // 升级只可能是 GET：其它方法即便带头也不能拿到 101。
    const posted = await rawConnect(server.port, {method: 'POST'});
    try {
      assert.equal(posted.status, 405);
    } finally {
      posted.close();
    }
  });

  it('配置了来源白名单后，陌生网页连不上', async () => {
    const guarded = await startTestServer({allowedOrigins: ['https://poker.example']}, {storage: 'memory'});
    try {
      const stranger = await rawConnect(guarded.port, {origin: 'https://evil.example'});
      try {
        assert.equal(stranger.status, 403, '跨站网页不该能开这条连接');
      } finally {
        stranger.close();
      }
      // 白名单内的来源照常升级；不带 Origin 的客户端（小程序、原生）不受影响。
      const allowed = await rawConnect(guarded.port, {origin: 'https://poker.example'});
      try {
        assert.equal(allowed.status, 101);
      } finally {
        allowed.close();
      }
      const originless = await rawConnect(guarded.port);
      try {
        assert.equal(originless.status, 101);
      } finally {
        originless.close();
      }
    } finally {
      await guarded.close();
    }
  });

  it('未掩码的客户端帧直接按协议错误关闭', async () => {
    const client = await rawConnect(server.port);
    try {
      client.send(clientFrame(OPCODE.text, Buffer.from('{"type":"ping"}', 'utf8'), {mask: false}));
      await until(() => client.closeFrames().length > 0, '关闭帧');
      assert.equal(client.closeFrames()[0]!.payload.readUInt16BE(0), 1002);
    } finally {
      client.close();
    }
  });

  it('RSV 位非零按协议错误关闭', async () => {
    const client = await rawConnect(server.port);
    try {
      client.send(clientFrame(OPCODE.text, Buffer.from('{}', 'utf8'), {rsv: 0x40}));
      await until(() => client.closeFrames().length > 0, '关闭帧');
      assert.equal(client.closeFrames()[0]!.payload.readUInt16BE(0), 1002);
    } finally {
      client.close();
    }
  });

  it('分片消息被重组后照常处理', async () => {
    const client = await rawConnect(server.port);
    try {
      const json = JSON.stringify({type: 'subscribe', token, roomId});
      const bytes = Buffer.from(json, 'utf8');
      client.send(clientFrame(OPCODE.text, bytes.subarray(0, 9), {fin: false}));
      client.send(clientFrame(OPCODE.continuation, bytes.subarray(9, 30), {fin: false}));
      client.send(clientFrame(OPCODE.continuation, bytes.subarray(30)));
      await until(() => client.messages().some(message => message.type === 'state'), '订阅成功');
      const [state] = client.messages().filter(message => message.type === 'state');
      assert.equal(state.room.id, roomId);
      assert.equal(state.room.you.userId, userId, '重组后的订阅必须认出订阅者');
    } finally {
      client.close();
    }
  });

  it('分片顺序错乱或过长都会被拒绝', async () => {
    const orphan = await rawConnect(server.port);
    try {
      orphan.send(clientFrame(OPCODE.continuation, Buffer.from('x', 'utf8')));
      await until(() => orphan.closeFrames().length > 0, '孤儿分片');
      assert.equal(orphan.closeFrames()[0]!.payload.readUInt16BE(0), 1002);
    } finally {
      orphan.close();
    }

    const interleaved = await rawConnect(server.port);
    try {
      interleaved.send(clientFrame(OPCODE.text, Buffer.from('{"a"', 'utf8'), {fin: false}));
      interleaved.send(clientText('{"b"}'));
      await until(() => interleaved.closeFrames().length > 0, '交叉消息');
      assert.equal(interleaved.closeFrames()[0]!.payload.readUInt16BE(0), 1002);
    } finally {
      interleaved.close();
    }
  });

  it('二进制帧与非法 UTF-8 各自的关闭码', async () => {
    const binary = await rawConnect(server.port);
    try {
      binary.send(clientFrame(OPCODE.binary, Buffer.from([1, 2, 3])));
      await until(() => binary.closeFrames().length > 0, '二进制关闭');
      assert.equal(binary.closeFrames()[0]!.payload.readUInt16BE(0), 1003);
    } finally {
      binary.close();
    }

    const broken = await rawConnect(server.port);
    try {
      // A lone continuation byte: valid bytes, invalid UTF-8 text.
      broken.send(clientFrame(OPCODE.text, Buffer.from([0x80, 0x81])));
      await until(() => broken.closeFrames().length > 0, '坏文本关闭');
      assert.equal(broken.closeFrames()[0]!.payload.readUInt16BE(0), 1007);
    } finally {
      broken.close();
    }
  });

  it('超过上限的消息被拒绝，上限之内的大消息能通过', async () => {
    const tooBig = await rawConnect(server.port);
    try {
      const payload = Buffer.alloc(WS_MESSAGE_LIMIT_BYTES + 1, 0x61);
      tooBig.send(clientFrame(OPCODE.text, payload));
      await until(() => tooBig.closeFrames().length > 0, '超限关闭');
      assert.equal(tooBig.closeFrames()[0]!.payload.readUInt16BE(0), 1009);
    } finally {
      tooBig.close();
    }

    // Just under the limit still parses as a message (here: an unknown type).
    const big = await rawConnect(server.port);
    try {
      const filler = 'x'.repeat(WS_MESSAGE_LIMIT_BYTES - 200);
      big.send(clientText(JSON.stringify({type: 'noop', filler})));
      await until(() => big.messages().some(message => message.type === 'error'), '大消息应答');
      assert.equal(big.closeFrames().length, 0, '合法的 64KB 消息不该断开连接');
    } finally {
      big.close();
    }
  });

  it('客户端一走，服务端的连接就跟着释放', async () => {
    const connections = (): Promise<number> =>
      new Promise(resolve => server.app.server.getConnections((_error, count) => resolve(count)));
    // Drop the keep-alive sockets the HTTP test helpers left behind, so the count
    // below is about this one connection.
    server.app.server.closeIdleConnections();
    await until(async () => (await connections()) === 0, '空闲连接清空');

    const client = await rawConnect(server.port, {extra: subscribeFrame()});
    await until(() => client.messages().some(message => message.type === 'state'), '订阅成功');
    await until(async () => (await connections()) === 1, '服务端登记连接');

    // The client vanishes without a close handshake, the way a closed tab does:
    // the server must not sit on a half-open socket (it would block shutdown).
    client.close();
    await until(async () => (await connections()) === 0, '服务端释放连接');
  });

  it('ping 原样 pong，close 回显后断开', async () => {
    const client = await rawConnect(server.port);
    try {
      const payload = Buffer.from('心跳', 'utf8');
      client.send(clientFrame(OPCODE.ping, payload));
      await until(() => client.frames.some(frame => frame.opcode === OPCODE.pong), 'pong');
      const pong = client.frames.find(frame => frame.opcode === OPCODE.pong)!;
      assert.deepEqual(pong.payload, payload, 'pong 必须原样回显 ping 的载荷');

      client.send(clientFrame(OPCODE.close, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('再见', 'utf8')])));
      await until(() => client.closeFrames().length > 0, '关闭回显');
      assert.equal(client.closeFrames()[0]!.payload.readUInt16BE(0), 1000);
      await until(() => client.ended, 'TCP 关闭');
    } finally {
      client.close();
    }
  });

  it('升级请求里捎带的第一帧也会被处理', async () => {
    const client = await rawConnect(server.port, {extra: subscribeFrame()});
    try {
      await until(() => client.messages().some(message => message.type === 'state'), '订阅成功');
    } finally {
      client.close();
    }
  });

  it('服务端按心跳发 ping，不回应的连接被关闭', async () => {
    const beat = await startTestServer({}, {storage: 'memory', heartbeatMs: 30000});
    try {
      const client = await rawConnect(beat.port);
      try {
        await beat.clock.advance(30000);
        await until(() => client.pings().length >= 1, '心跳 ping');
        assert.equal(client.closeFrames().length, 0, '回应之前不该关闭');

        // Past the 60s pong timeout: the next tick sees a silent peer and closes.
        await beat.clock.advance(61000);
        await until(() => client.closeFrames().length > 0, '心跳超时关闭');
        assert.equal(client.closeFrames()[0]!.payload.readUInt16BE(0), 1001);
      } finally {
        client.close();
      }
    } finally {
      await beat.close();
    }
  });

  it('回应 pong 的连接在同样的时间跨度里活下来', async () => {
    const beat = await startTestServer({}, {storage: 'memory', heartbeatMs: 30000});
    try {
      const client = await rawConnect(beat.port);
      try {
        const pings = (): number => client.pings().length;
        // Three intervals, past the 60s pong timeout: answering keeps the socket.
        for (let index = 0; index < 3; index++) {
          await beat.clock.advance(30000);
          await until(() => pings() > index, '心跳 ping');
          client.send(clientFrame(OPCODE.pong, Buffer.alloc(0)));
          // An application ping proves the server has read everything we sent,
          // including the pong that keeps this connection alive.
          client.send(clientText('{"type":"ping"}'));
          await until(
            () => client.messages().filter(message => message.type === 'pong').length > index,
            '应用层 pong',
          );
        }
        assert.equal(client.closeFrames().length, 0);
        assert.equal(client.ended, false, '回应心跳的连接必须活着');
      } finally {
        client.close();
      }
    } finally {
      await beat.close();
    }
  });
});

describe('帧编解码', () => {
  it('长度字段按 7/16/64 位选择，服务端帧不掩码', () => {
    const short = encodeText('hi');
    assert.equal(short[0], 0x81);
    assert.equal(short[1], 2, '小于 126 用 7 位长度');
    assert.equal(short.length, 4);

    const medium = encodeText('x'.repeat(200));
    assert.equal(medium[1], 126, '126..65535 用 16 位长度');
    assert.equal(medium.readUInt16BE(2), 200);
    assert.equal(medium.length, 4 + 200);

    const long = encodeText('x'.repeat(65536));
    assert.equal(long[1], 127, '65536 以上用 64 位长度');
    assert.equal(Number(long.readBigUInt64BE(2)), 65536);
    assert.equal(long.length, 10 + 65536);
    assert.equal(long[1]! & 0x80, 0, '服务端帧绝不掩码');
  });

  it('关闭帧带状态码，原因被截到协议上限', () => {
    const frame = encodeClose(4000, '房间已满');
    assert.equal(frame[0], 0x88, 'FIN + close opcode');
    assert.equal(frame.readUInt16BE(2), 4000);
    assert.equal(frame.subarray(4).toString('utf8'), '房间已满');

    // 123 bytes is the protocol limit for the reason, so a long reason is cut.
    const long = encodeClose(1000, 'x'.repeat(400));
    assert.equal(long[1]! & 0x7f, 2 + 123);
    assert.equal(long.length, 2 + 2 + 123);
  });
});
