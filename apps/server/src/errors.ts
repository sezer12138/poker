import {FairnessError} from '../../../packages/fairness/src/index.ts';
import {RuleError} from '../../../packages/poker-engine/src/index.ts';

export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_ACTION'
  | 'HAND_FINISHED'
  | 'MATCH_FINISHED'
  | 'INVALID_DECK'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'NOT_READY'
  | 'START_MIN_PLAYERS'
  | 'ROOM_FULL'
  | 'ROOM_LOCKED'
  | 'ALREADY_CONTRIBUTED'
  | 'CONTRIBUTE_CLOSED'
  | 'GUEST_DISABLED'
  | 'WECHAT_NOT_CONFIGURED'
  | 'WECHAT_UNAVAILABLE'
  | 'WECHAT_AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'AUDIT_LOCKED'
  | 'STORAGE_FAILED'
  | 'BAD_MESSAGE'
  | 'INTERNAL';

const STATUS: Record<AppErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_YOUR_TURN: 409,
  ILLEGAL_ACTION: 400,
  HAND_FINISHED: 409,
  MATCH_FINISHED: 409,
  INVALID_DECK: 500,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  NOT_READY: 409,
  START_MIN_PLAYERS: 409,
  ROOM_FULL: 409,
  ROOM_LOCKED: 403,
  ALREADY_CONTRIBUTED: 409,
  CONTRIBUTE_CLOSED: 409,
  GUEST_DISABLED: 403,
  WECHAT_NOT_CONFIGURED: 501,
  WECHAT_UNAVAILABLE: 503,
  WECHAT_AUTH_FAILED: 401,
  RATE_LIMITED: 429,
  AUDIT_LOCKED: 403,
  STORAGE_FAILED: 500,
  BAD_MESSAGE: 400,
  INTERNAL: 500,
};

/** Every user-visible message is a fixed Chinese string; no state is interpolated. */
const MESSAGE: Record<AppErrorCode, string> = {
  INVALID_INPUT: '请求参数不合法',
  NOT_YOUR_TURN: '现在不是你的行动回合',
  ILLEGAL_ACTION: '该操作不合法',
  HAND_FINISHED: '本手已经结束',
  MATCH_FINISHED: '比赛已经结束',
  INVALID_DECK: '服务器内部错误',
  UNAUTHORIZED: '登录已失效，请重新登录',
  FORBIDDEN: '你没有权限执行该操作',
  NOT_FOUND: '房间不存在',
  VERSION_CONFLICT: '房间状态已更新，请刷新后重试',
  NOT_READY: '还有玩家未准备',
  START_MIN_PLAYERS: '至少需要 2 名玩家',
  ROOM_FULL: '房间已满',
  ROOM_LOCKED: '比赛进行中，不能加入',
  ALREADY_CONTRIBUTED: '本手你已经提交过随机贡献',
  CONTRIBUTE_CLOSED: '本手的贡献窗口已关闭',
  GUEST_DISABLED: '生产环境已禁用游客登录，请使用微信登录',
  WECHAT_NOT_CONFIGURED: '微信登录未配置，开发模式请使用游客登录',
  WECHAT_UNAVAILABLE: '微信登录暂不可用，请稍后再试',
  WECHAT_AUTH_FAILED: '微信登录失败，请重试',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  AUDIT_LOCKED: '比赛结束后可核验',
  STORAGE_FAILED: '存储失败，操作未生效',
  BAD_MESSAGE: '消息格式不合法',
  INTERNAL: '服务器内部错误',
};

export class AppError extends Error {
  code: AppErrorCode;
  status: number;

  constructor(code: AppErrorCode, message?: string) {
    super(message ?? MESSAGE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
  }
}

const FAIRNESS_CODES: Record<string, AppErrorCode> = {
  DUPLICATE_CONTRIBUTION: 'ALREADY_CONTRIBUTED',
  ALREADY_FINALIZED: 'CONTRIBUTE_CLOSED',
  INVALID_SEAT: 'INVALID_INPUT',
  INVALID_NONCE: 'INVALID_INPUT',
  INVALID_SEATS: 'INVALID_INPUT',
  INVALID_INPUT: 'INVALID_INPUT',
};

/** Engine and fairness errors become typed API errors; unknown failures stay opaque. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof RuleError) return new AppError(error.code as AppErrorCode);
  if (error instanceof FairnessError) return new AppError(FAIRNESS_CODES[error.code] ?? 'INVALID_INPUT');
  return new AppError('INTERNAL');
}
