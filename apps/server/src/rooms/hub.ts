export interface Connection {
  readonly id: string;
  readonly userId: string;
  roomId: string | null;
  send(message: unknown): void;
  close(code: number, reason: string): void;
}

/** Subscription table for live connections; the newest socket per user wins. */
export class Hub {
  private rooms = new Map<string, Map<string, Connection>>();

  /** Returns the connection that was displaced, if the same user was already here. */
  subscribe(conn: Connection, roomId: string): Connection | null {
    this.unsubscribe(conn);
    let members = this.rooms.get(roomId);
    if (!members) {
      members = new Map();
      this.rooms.set(roomId, members);
    }
    const previous = members.get(conn.userId) ?? null;
    members.set(conn.userId, conn);
    conn.roomId = roomId;
    return previous === conn ? null : previous;
  }

  unsubscribe(conn: Connection): void {
    const roomId = conn.roomId;
    if (roomId === null) return;
    const members = this.rooms.get(roomId);
    if (members && members.get(conn.userId) === conn) members.delete(conn.userId);
    if (members && members.size === 0) this.rooms.delete(roomId);
    conn.roomId = null;
  }

  /** Called when a socket goes away, whatever it was subscribed to. */
  remove(conn: Connection): void {
    this.unsubscribe(conn);
  }

  /** Drops every socket of a user in a room, e.g. after they leave the membership. */
  evict(roomId: string, userId: string): Connection | null {
    const members = this.rooms.get(roomId);
    const conn = members?.get(userId) ?? null;
    if (!conn) return null;
    members!.delete(userId);
    if (members!.size === 0) this.rooms.delete(roomId);
    conn.roomId = null;
    return conn;
  }

  closeRoom(roomId: string): Connection[] {
    const members = this.rooms.get(roomId);
    if (!members) return [];
    const conns = [...members.values()];
    this.rooms.delete(roomId);
    for (const conn of conns) conn.roomId = null;
    return conns;
  }

  online(userId: string): boolean {
    for (const members of this.rooms.values()) if (members.has(userId)) return true;
    return false;
  }

  onlineIn(roomId: string): (userId: string) => boolean {
    const members = this.rooms.get(roomId);
    if (!members) return () => false;
    return userId => members.has(userId);
  }

  countIn(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  connectionsIn(roomId: string): Connection[] {
    return [...(this.rooms.get(roomId)?.values() ?? [])];
  }

  /** Builds one message per recipient: views are never shared between clients. */
  broadcast(roomId: string, build: (conn: Connection) => unknown | null): void {
    const members = this.rooms.get(roomId);
    if (!members) return;
    for (const conn of [...members.values()]) {
      const message = build(conn);
      if (message !== null && message !== undefined) conn.send(message);
    }
  }
}
