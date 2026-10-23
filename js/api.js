// サーバー通信（共通部分とCloudflare Workers版）。
// 送るのは「アカウント認証」と「点数」だけ。映像・画像・ポーズ座標はここを通らない。
//
// バックエンドは差し替え可能で、どれも同じ形のオブジェクトを返す:
//   { enabled, limits:{submitMs,rankingPollMs}, restore(), register(name,pw), login(name,pw),
//     score(value,{keepalive,bonus}), ranking(), logout(), deleteAccount(name,pw) }
// 設定は config.js の window.HANT_CONFIG で選ぶ（backend:'firebase' | 'worker'）。
const enc = new TextEncoder();
export const PBKDF2_ITER = 150000;
export const NAME_MAX = 16;

export const b64url = (buf) => {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const squash = (s) => String(s).normalize('NFKC').trim().replace(/\s+/g, ' ');
export const normName = (s) => squash(s).toLowerCase();

/** 表示名の検査（サーバー側と同じ規則）。問題なければ整形済みの名前、だめならnull。 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = squash(raw);
  const len = [...n].length;
  if (len < 1 || len > NAME_MAX) return null;
  if (/[\p{C}\p{Zl}\p{Zp}/]/u.test(n)) return null; // 制御・不可視文字と '/' は禁止
  return n;
}
export const looksPersonal = (n) => /@|https?:|www\./i.test(n) || /\d{7,}/.test(n);

/**
 * パスワードを、サーバーに渡す前にブラウザ内で PBKDF2(15万回) にかける。
 * → サーバー（と通信経路・サーバーログ）に「生のパスワード」は一切届かない。
 *   他サイトと同じパスワードを使い回していても、ここから逆算されにくい。
 */
export async function deriveSecret(secret, name) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const salt = enc.encode(`hant-inmu-v1|pw|${normName(name)}`);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return b64url(bits);
}

export class ApiError extends Error {
  constructor(code, status, retryAfter) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter || 0; }
}

export const ERROR_TEXT = {
  no_server: 'サーバーが設定されていません（ゲストで遊べます）',
  network: '通信できませんでした。ネットワークを確認してください',
  bad_name: '名前は1〜16文字で、見えない文字や「/」は使えません',
  name_looks_personal: 'メールアドレス・URL・長い数字は名前に使えません（個人情報は入れないでください）',
  bad_secret: 'パスワードの形式が正しくありません',
  name_taken: 'その名前はすでに使われています',
  invalid_credentials: '名前かパスワードが違います',
  locked: '失敗が続いたため、しばらくロックされています',
  busy: '登録が混み合っています。少し待ってからお試しください',
  full: '現在、新規登録を受け付けていません',
  unauthorized: 'ログインの有効期限が切れました。もう一度ログインしてください',
  origin_not_allowed: 'このサイトからは利用できません（サーバー設定を確認してください）',
  server_not_configured: 'サーバーの設定が未完了です',
  server_error: 'サーバーでエラーが発生しました',
  setup_error: 'サーバーの設定が不足しています（READMEの手順を確認してください）',
};
export function describeError(e) {
  if (!(e instanceof ApiError)) return String(e && e.message || e);
  let t = ERROR_TEXT[e.code] || `エラー (${e.code})`;
  if (e.code === 'locked' && e.retryAfter) t += `（あと約${Math.ceil(e.retryAfter / 60)}分）`;
  return t;
}

/** 使うバックエンドを設定から選ぶ */
export async function createBackend(cfg = {}, deps = {}) {
  if (cfg.backend === 'firebase' && cfg.firebase && cfg.firebase.projectId) {
    const { createFirebaseApi } = await import('./firebase-api.js');
    return createFirebaseApi(cfg.firebase, deps);
  }
  return createWorkerApi(cfg.apiBase || '', deps);
}

/* ---------------- Cloudflare Workers 版 ---------------- */
export function createWorkerApi(base, { fetchImpl, storage } = {}) {
  const root = String(base || '').replace(/\/+$/, '');
  const f = fetchImpl || ((...a) => fetch(...a));
  const store = storage || { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* noop */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } } };
  let token = '';
  async function call(method, path, body, { keepalive = false } = {}) {
    if (!root) throw new ApiError('no_server', 0);
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await f(root + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', keepalive });
    } catch { throw new ApiError('network', 0); }
    let data = null; try { data = await res.json(); } catch { /* 本文なし */ }
    if (!res.ok) throw new ApiError((data && data.error) || 'server_error', res.status, data && data.retry_after);
    return data;
  }
  const accept = (r) => { token = r.token; store.set('hant8_token', token); return { account: r.account }; };
  return {
    kind: 'worker',
    enabled: !!root,
    limits: { submitMs: 10000, rankingPollMs: 20000 },
    get token() { return token; },
    async restore() {
      const t = store.get('hant8_token'); if (!t) return null;
      token = t;
      try { return (await call('GET', '/api/me')).account; }
      catch (e) { if (e instanceof ApiError && e.code === 'unauthorized') { token = ''; store.del('hant8_token'); return null; } throw e; }
    },
    async register(name, pw) { return accept(await call('POST', '/api/register', { name, pw: await deriveSecret(pw, name) })); },
    async login(name, pw) { return accept(await call('POST', '/api/login', { name, pw: await deriveSecret(pw, name) })); },
    score(score, opts) { return call('POST', '/api/score', opts && opts.bonus ? { score, bonus: true } : { score }, opts); },
    ranking() { return call('GET', '/api/ranking'); },
    async logout() { try { if (token) await call('POST', '/api/logout', {}); } finally { token = ''; store.del('hant8_token'); } },
    async deleteAccount(name, pw) { await call('POST', '/api/delete', { pw: await deriveSecret(pw, name) }); token = ''; store.del('hant8_token'); },
  };
}
