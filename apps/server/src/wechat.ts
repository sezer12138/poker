import {AppError} from './errors.ts';


export interface WechatConfig {
  appId: string;
  secret: string;
}

interface SessionResponse {
  openid?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
}

const ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session';

/**
 * Exchanges a mini program login code for an openid. The session key returned by
 * WeChat is deliberately dropped: this game never needs to decrypt user data.
 */
export async function exchangeCode(
  config: WechatConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
    throw new AppError('INVALID_INPUT', '登录凭证不合法');
  }
  const url =
    `${ENDPOINT}?appid=${encodeURIComponent(config.appId)}` +
    `&secret=${encodeURIComponent(config.secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  let payload: SessionResponse;
  try {
    const response = await fetchImpl(url, {signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = (await response.json()) as SessionResponse;
  } catch (error) {
    console.error('[wechat] 调用 jscode2session 失败', error);
    throw new AppError('WECHAT_AUTH_FAILED');
  }

  if (typeof payload.errcode === 'number' && payload.errcode !== 0) {
    // The code itself is never logged: it is a single-use credential.
    console.error(`[wechat] 登录被拒绝 errcode=${payload.errcode}`);
    throw new AppError('WECHAT_AUTH_FAILED');
  }
  if (typeof payload.openid !== 'string' || payload.openid.length === 0) {
    throw new AppError('WECHAT_AUTH_FAILED');
  }
  return payload.openid;
}
