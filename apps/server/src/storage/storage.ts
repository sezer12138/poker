import type {Card, Tournament} from '../../../../packages/poker-engine/src/index.ts';
import type {FairRound} from '../../../../packages/fairness/src/index.ts';

export type RoomStatus = 'waiting' | 'playing' | 'finished';
export type FairnessStageName = 'collecting' | 'dealing' | 'playing' | 'settled';

export interface Member {
  userId: string;
  name: string;
  seat: number;
  bot: boolean;
  ready: boolean;
  joinedAt: number;
}

export interface DealtCards {
  /** Hole cards per seat exactly as they went out, for the post-match audit. */
  holes: Record<string, Card[]>;
  board: Card[];
  burned: Card[];
}

export interface FairnessStage {
  stage: FairnessStageName;
  handNo: number;
  /** Seats of the hand being dealt, fixed when the hand opens. */
  seats: number[];
  round: FairRound;
  deck: Card[] | null;
  dealt: DealtCards | null;
  /** Button seat of this hand, needed to replay the deal order in the audit. */
  button: number | null;
}

export interface FairnessRecord {
  handNo: number;
  round: FairRound;
  deck: Card[];
  dealt: DealtCards | null;
  button: number | null;
}

export interface PublicEvent {
  seq: number;
  handNo: number;
  type: string;
  text: string;
}

export interface Deadlines {
  action: number | null;
  actionSeat: number | null;
  actionHandNo: number | null;
  contribution: number | null;
  nextHand: number | null;
}

export interface IdempotentRecord {
  viewJson: string;
  version: number;
  at: number;
  /** 发起这条命令的用户。缺失（老快照）时该记录不会被回放。 */
  userId?: string;
}

export interface PersistedRoom {
  v: 1;
  id: string;
  code: string;
  invite: string;
  name: string;
  version: number;
  status: RoomStatus;
  hostId: string;
  members: Member[];
  matchId: string | null;
  tournament: Tournament | null;
  fairnessStage: FairnessStage | null;
  fairnessHistory: FairnessRecord[];
  events: PublicEvent[];
  seq: number;
  idempotency: [string, IdempotentRecord][];
  deadlines: Deadlines;
  notice: string;
  lastActivityAt: number;
  createdAt: number;
}

export interface Session {
  userId: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}

export interface Storage {
  init(): Promise<void>;
  loadRoom(id: string): Promise<PersistedRoom | null>;
  saveRoom(room: PersistedRoom): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  loadRooms(): Promise<PersistedRoom[]>;
  loadSessions(): Promise<Record<string, Session>>;
  saveSessions(sessions: Record<string, Session>): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rejects a snapshot that is not shaped like a room before it can reach the
 * coordinator. A corrupt file must never take the server down.
 */
export function assertPersistedRoom(value: unknown): PersistedRoom {
  if (!isRecord(value)) throw new Error('房间快照必须是对象');
  if (value['v'] !== 1) throw new Error('房间快照版本不受支持');
  for (const key of ['id', 'code', 'invite', 'name', 'hostId'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) throw new Error(`房间快照缺少 ${key}`);
  }
  if (!Number.isSafeInteger(value['version']) || (value['version'] as number) < 0) throw new Error('房间版本非法');
  if (!['waiting', 'playing', 'finished'].includes(value['status'] as string)) throw new Error('房间状态非法');
  if (!Array.isArray(value['members'])) throw new Error('房间成员列表非法');
  if (!Array.isArray(value['fairnessHistory'])) throw new Error('公平记录列表非法');
  if (!Array.isArray(value['events'])) throw new Error('事件列表非法');
  if (!Array.isArray(value['idempotency'])) throw new Error('幂等记录列表非法');
  if (!isRecord(value['deadlines'])) throw new Error('截止时间非法');
  if (!Number.isSafeInteger(value['seq'])) throw new Error('事件序号非法');
  return value as unknown as PersistedRoom;
}

export function assertSession(value: unknown): Session {
  if (!isRecord(value)) throw new Error('会话记录必须是对象');
  if (typeof value['userId'] !== 'string' || typeof value['name'] !== 'string') throw new Error('会话记录缺少用户');
  if (!Number.isSafeInteger(value['createdAt']) || !Number.isSafeInteger(value['lastSeen'])) {
    throw new Error('会话时间非法');
  }
  return value as unknown as Session;
}
