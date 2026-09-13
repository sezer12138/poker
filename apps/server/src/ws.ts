import {createHash} from 'node:crypto';
import type {Duplex} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {WS_MESSAGE_LIMIT_BYTES} from './config.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  invalidPayload: 1007,
  tooLarge: 1009,
  policyViolation: 1008,
} as const;

export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(`${key}${GUID}`)
    .digest('base64');
}

export interface UpgradeOptions {
  /** 非空时校验 Origin；小程序等非浏览器客户端不带 Origin，一律放行。 */
  allowedOrigins?: readonly string[];
}

/** Returns the 101 response for a valid upgrade request, or an HTTP error response. */
export function upgradeResponse(
  req: IncomingMessage,
  options: UpgradeOptions = {},
): {ok: true; response: string} | {ok: false; status: number; message: string} {
  // 升级只可能是 GET；放行其它方法会得到一条语义上不成立的 101。
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    return {ok: false, status: 405, message: 'WebSocket upgrade requires GET'};
  }
  const allowed = options.allowedOrigins ?? [];
  const origin = req.headers.origin;
  if (allowed.length > 0 && typeof origin === 'string' && origin !== '' && !allowed.includes(origin)) {
    return {ok: false, status: 403, message: 'Origin not allowed'};
  }
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (upgrade !== 'websocket' || !connection.split(',').some(part => part.trim() === 'upgrade')) {
    return {ok: false, status: 400, message: 'Expected a WebSocket upgrade'};
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    return {ok: false, status: 400, message: 'Invalid Sec-WebSocket-Key'};
  }
  const version = String(req.headers['sec-websocket-version'] ?? '');
  if (version !== '13') return {ok: false, status: 426, message: 'Unsupported WebSocket version'};
  // Extensions (permessage-deflate) are deliberately not negotiated.
  return {
    ok: true,
    response:
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  };
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
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
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'));
}

export function encodeClose(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OPCODE.close, payload);
}

export function encodePong(payload: Buffer): Buffer {
  return encodeFrame(OPCODE.pong, payload);
}

export function encodePing(payload: Buffer = Buffer.alloc(0)): Buffer {
  return encodeFrame(OPCODE.ping, payload);
}

export interface FrameEvents {
  message(text: string): void;
  close(code: number, reason: string): void;
  protocolError(code: number, reason: string): void;
  ping(payload: Buffer): void;
  /** Any complete frame, including pongs, proves the peer is still there. */
  activity?(): void;
}

/**
 * Incremental RFC 6455 frame decoder for the server side of a connection.
 * Reassembles fragments, enforces masking, and caps the message size.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private fragmentSize = 0;
  private decoder = new TextDecoder('utf-8', {fatal: true});
  private closed = false;
  private events: FrameEvents;
  private limit: number;

  constructor(events: FrameEvents, limit: number = WS_MESSAGE_LIMIT_BYTES) {
    this.events = events;
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed && this.decodeOne()) {
      // Keep parsing while whole frames remain buffered.
    }
  }

  private fail(code: number, reason: string): void {
    this.closed = true;
    this.events.protocolError(code, reason);
  }

  /** Returns false when the buffer does not yet hold a whole frame. */
  private decodeOne(): boolean {
    const buffer = this.buffer;
    if (buffer.length < 2) return false;
    const first = buffer[0]!;
    const second = buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      this.fail(CLOSE.protocolError, 'RSV bits must be zero');
      return false;
    }
    if (!masked) {
      this.fail(CLOSE.protocolError, 'Client frames must be masked');
      return false;
    }
    if (length === 126) {
      if (buffer.length < offset + 2) return false;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return false;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.fail(CLOSE.tooLarge, 'Frame too large');
        return false;
      }
      length = Number(big);
      offset += 8;
    }
    const control = opcode >= 0x8;
    if (control && (length > 125 || !fin)) {
      this.fail(CLOSE.protocolError, 'Control frames must be short and final');
      return false;
    }
    if (length > this.limit) {
      this.fail(CLOSE.tooLarge, 'Message too large');
      return false;
    }
    if (buffer.length < offset + 4 + length) return false;
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = buffer[offset + i]! ^ mask[i & 3]!;
    this.buffer = buffer.subarray(offset + length);
    this.events.activity?.();

    if (control) {
      this.handleControl(opcode, payload);
      return true;
    }
    return this.handleData(fin, opcode, payload);
  }

  private handleControl(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal;
      this.closed = true;
      this.events.close(code, payload.length > 2 ? payload.subarray(2).toString('utf8') : '');
      return;
    }
    if (opcode === OPCODE.ping) {
      this.events.ping(payload);
      return;
    }
    if (opcode === OPCODE.pong) return;
    this.fail(CLOSE.protocolError, 'Unknown control opcode');
  }

  private handleData(fin: boolean, opcode: number, payload: Buffer): boolean {
    if (opcode === OPCODE.binary) {
      this.fail(CLOSE.unsupportedData, 'Binary frames are not supported');
      return false;
    }
    if (opcode === OPCODE.continuation) {
      if (this.fragmentOpcode === null) {
        this.fail(CLOSE.protocolError, 'Unexpected continuation frame');
        return false;
      }
    } else if (opcode === OPCODE.text) {
      if (this.fragmentOpcode !== null) {
        this.fail(CLOSE.protocolError, 'New message before the previous one finished');
        return false;
      }
      this.fragmentOpcode = OPCODE.text;
    } else {
      this.fail(CLOSE.protocolError, 'Unknown data opcode');
      return false;
    }

    this.fragmentSize += payload.length;
    if (this.fragmentSize > this.limit) {
      this.fail(CLOSE.tooLarge, 'Message too large');
      return false;
    }
    this.fragments.push(payload);
    if (!fin) return true;

    const complete = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentSize = 0;
    this.fragmentOpcode = null;
    let text: string;
    try {
      text = this.decoder.decode(complete);
    } catch {
      this.fail(CLOSE.invalidPayload, 'Invalid UTF-8');
      return false;
    }
    this.events.message(text);
    return true;
  }
}

export interface SocketConnection {
  send(text: string): void;
  close(code: number, reason: string): void;
  ping(): void;
  end(): void;
  /** Feeds bytes that arrived before the connection object existed (upgrade head). */
  push(chunk: Buffer): void;
}

/**
 * Wires a socket that has already been upgraded into the frame codec. The
 * caller owns the connection lifecycle through the callbacks.
 */
export function attachSocket(options: {
  socket: Duplex;
  onMessage: (connection: SocketConnection, text: string) => void;
  onClose: (connection: SocketConnection) => void;
  onActivity?: (connection: SocketConnection) => void;
  limit?: number;
}): SocketConnection {
  const {socket} = options;
  let open = true;
  const decoder = new FrameDecoder(
    {
      message: text => options.onMessage(connection, text),
      activity: () => options.onActivity?.(connection),
      close: (code, reason) => {
        if (open) socket.write(encodeClose(code, reason));
        finish();
        socket.end();
      },
      protocolError: (code, reason) => {
        if (open) socket.write(encodeClose(code, reason));
        finish();
        socket.destroy();
      },
      ping: payload => {
        if (open) socket.write(encodePong(payload));
      },
    },
    options.limit,
  );

  const connection: SocketConnection = {
    send(text) {
      if (!open) return;
      socket.write(encodeText(text));
    },
    close(code, reason) {
      if (!open) return;
      socket.write(encodeClose(code, reason));
      finish();
      socket.end();
    },
    ping() {
      if (open) socket.write(encodePing());
    },
    end() {
      finish();
      socket.end();
    },
    push(chunk) {
      decoder.push(chunk);
    },
  };

  function finish(): void {
    if (!open) return;
    open = false;
    options.onClose(connection);
  }

  socket.on('data', chunk => decoder.push(chunk as Buffer));
  socket.on('error', () => {
    finish();
    socket.destroy();
  });
  socket.on('close', () => finish());
  // An upgraded socket is half-open: when the peer stops reading we are left with a
  // writable socket that never closes, keeping the connection alive in the server's
  // bookkeeping (and blocking shutdown) for a client that has long since gone.
  socket.on('end', () => {
    finish();
    if (!socket.destroyed) socket.end();
  });
  return connection;
}
