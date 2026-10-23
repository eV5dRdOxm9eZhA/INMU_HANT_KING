// HANT_INMU_PLAY ランキング/アカウント API  (Cloudflare Workers + D1)
//
// ■ プライバシー設計（サーバーが破られても漏れるものが無い）
//   - 映像・画像・音声・ポーズ座標は一切受け取らない（判定はブラウザ内で完結）。
//   - IPアドレス・User-Agent・Referer・Cookie など、リクエストの付帯情報は「読まない・保存しない・ログに出さない」。
//   - DBに入るのは: アカウントID / 表示名 / 認証用ハッシュ / 点数 / 最終アクセス(分単位) だけ。
//   - パスワードは、ブラウザ側で PBKDF2(15万回) を掛けた値しか届かない（生の文字列はサーバーに来ない）。
//     サーバーはそれを更に「秘密のペッパー + ソルト」で HMAC して保存する。
//     DBだけ流出してもペッパーが無ければ検証すらできず、両方漏れてもブラウザ側のPBKDF2が残る。
//   - 180日アクセスの無いアカウントは自動削除（データ最小化）。

const enc = new TextEncoder();

const NAME_MAX = 16;
const SESSION_TTL = 30 * 86400;
const MAX_BODY = 2048;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/; // 32バイトのbase64url（ブラウザ側のPBKDF2出力）
const SCORE_RATE_PER_SEC = 100;           // クライアントの最大加点速度と同じ
const SCORE_SLACK = 50;
const SCORE_ABS_MAX = 1_000_000_000;
const INACTIVE_DAYS = 180;
const DEFAULT_MAX_ACCOUNTS = 50000;
const DEFAULT_REG_PER_HOUR = 60;

// ---------- 小物 ----------
const nowSec = () => Math.floor(Date.now() / 1000);
const b64url = (buf) => {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const randB64 = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomId = (len = 10) => {
  const r = crypto.getRandomValues(new Uint8Array(len)); let s = '';
  for (const x of r) s += ID_ALPHABET[x % ID_ALPHABET.length];
  return s;
};
async function sha256b64(text) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function hmacB64(pepper, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const lockSeconds = (fails, free, base, cap) => (fails < free ? 0 : Math.min(cap, base * 2 ** (fails - free)));

// 表示名: NFKC正規化・空白整理・制御/不可視文字禁止・16文字まで。メール/URL/長い数字列（電話番号等）は拒否。
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...n].length;
  if (len < 1 || len > NAME_MAX) return null;
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(n)) return null;
  return n;
}
const looksPersonal = (n) => /@|https?:|www\./i.test(n) || /\d{7,}/.test(n);

// ---------- 応答 ----------
function allowedOrigin(request, env) {
  const o = request.headers.get('Origin');
  if (!o) return null;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(o)) return o;
  if (env.ALLOW_LOCALHOST === '1' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return o;
  return null;
}
function baseHeaders(request, env, extra = {}) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  const o = allowedOrigin(request, env);
  if (o) { h['Access-Control-Allow-Origin'] = o; h['Vary'] = 'Origin'; }
  return h;
}
const json = (request, env, body, status = 200, extra) => new Response(JSON.stringify(body), { status, headers: baseHeaders(request, env, extra) });
const fail = (request, env, status, code, extra = {}) => json(request, env, { error: code, ...extra }, status);

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return { tooLarge: true };
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooLarge: true };
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? { v } : { bad: true }; } catch { return { bad: true }; }
}

// ---------- セッション ----------
async function createSession(env, accountId) {
  const token = randB64(32);
  const exp = nowSec() + SESSION_TTL;
  await env.DB.prepare('INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, ?, ?)').bind(await sha256b64(token), accountId, exp).run();
  // 1アカウントあたり最新5セッションだけ残す
  await env.DB.prepare(
    'DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY expires DESC LIMIT 5)'
  ).bind(accountId, accountId).run();
  return token;
}
async function authenticate(request, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  return env.DB.prepare(
    'SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?'
  ).bind(await sha256b64(m[1]), nowSec()).first();
}
const minuteStamp = () => Math.floor(nowSec() / 60) * 60; // 最終アクセスは「分」まで丸めて保存
const publicAccount = (a) => ({ id: a.id, name: a.name, score: a.score });

// ---------- ハンドラ ----------
async function register(request, env, body) {
  const name = cleanName(body.name);
  if (!name) return fail(request, env, 400, 'bad_name');
  if (looksPersonal(name)) return fail(request, env, 400, 'name_looks_personal');
  if (!B64URL_43.test(body.pw || '')) return fail(request, env, 400, 'bad_secret');
  const pepper = env.PEPPER;

  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM accounts').first()).c;
  if (total >= (Number(env.MAX_ACCOUNTS) || DEFAULT_MAX_ACCOUNTS)) return fail(request, env, 503, 'full');
  const hour = Math.floor(nowSec() / 3600);
  const recent = (await env.DB.prepare('SELECT COUNT(*) AS c FROM accounts WHERE created_h = ?').bind(hour).first()).c;
  if (recent >= (Number(env.REG_PER_HOUR) || DEFAULT_REG_PER_HOUR)) return fail(request, env, 429, 'busy', { retry_after: 3600 - (nowSec() % 3600) });

  const id = randomId();
  const pwSalt = randB64(16);
  const pwHash = await hmacB64(pepper, `pw|${pwSalt}|${body.pw}`);
  const t = nowSec();
  try {
    await env.DB.prepare(
      `INSERT INTO accounts (id, name, name_key, pw_salt, pw_hash, score, score_ts, last_access, created_h)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).bind(id, name, name.toLowerCase(), pwSalt, pwHash, t, minuteStamp(), hour).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return fail(request, env, 409, 'name_taken');
    throw e;
  }
  const token = await createSession(env, id);
  return json(request, env, { token, account: { id, name, score: 0 } }, 201);
}

async function login(request, env, body) {
  const name = cleanName(body.name);
  if (!name || !B64URL_43.test(body.pw || '')) return fail(request, env, 401, 'invalid_credentials');
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE name_key = ?').bind(name.toLowerCase()).first();
  if (!row) { await hmacB64(env.PEPPER, `pw|dummy|${body.pw}`); return fail(request, env, 401, 'invalid_credentials'); }
  const t = nowSec();
  if (row.lock_pw_until > t) return fail(request, env, 429, 'locked', { retry_after: row.lock_pw_until - t });
  const ok = safeEqual(await hmacB64(env.PEPPER, `pw|${row.pw_salt}|${body.pw}`), row.pw_hash);
  if (!ok) {
    const n = row.fail_pw + 1;
    await env.DB.prepare('UPDATE accounts SET fail_pw = ?, lock_pw_until = ? WHERE id = ?').bind(n, lockSeconds(n, 5, 30, 3600) ? t + lockSeconds(n, 5, 30, 3600) : 0, row.id).run();
    return fail(request, env, 401, 'invalid_credentials');
  }
  await env.DB.prepare('UPDATE accounts SET fail_pw = 0, lock_pw_until = 0, last_access = ? WHERE id = ?').bind(minuteStamp(), row.id).run();
  const token = await createSession(env, row.id);
  return json(request, env, { token, account: publicAccount(row) });
}

// 既存のDBに bonus_ts 列が無ければ、最初のスコア送信時に1回だけ追加する（既に有れば失敗するが無視してよい）
let schemaChecked = false;
async function ensureSchema(env) {
  if (schemaChecked) return; schemaChecked = true;
  try { await env.DB.prepare('ALTER TABLE accounts ADD COLUMN bonus_ts INTEGER NOT NULL DEFAULT 0').run(); } catch { /* 追加済み */ }
}
const BONUS_MAX = 30000;       // 完走ボーナス1回で上乗せできる最大点（曲の長さ×加点速度の範囲内）
const BONUS_COOLDOWN_SEC = 200; // 完走ボーナスを受け取れる最短間隔（曲の長さより少し短く）

async function postScore(request, env, body) {
  await ensureSchema(env);
  const acc = await authenticate(request, env);
  if (!acc) return fail(request, env, 401, 'unauthorized');
  let s = body.score;
  if (typeof s !== 'number' || !Number.isFinite(s)) return fail(request, env, 400, 'bad_score');
  s = Math.max(-SCORE_ABS_MAX, Math.min(SCORE_ABS_MAX, Math.round(s)));
  const t = nowSec();
  // 加点は「経過時間 × 最大加点速度」まで。減点（動画削除イベント等）は自由。
  const dt = Math.max(0, Math.min(3600, t - acc.score_ts));
  let maxUp = Math.round(SCORE_RATE_PER_SEC * dt * 1.25) + SCORE_SLACK;
  // 完走ボーナス（獲得点2倍）: 一定間隔に1回だけ、まとまった加点を許す。
  let bonusAt = acc.bonus_ts || 0;
  if (body.bonus === true && t - bonusAt >= BONUS_COOLDOWN_SEC) { maxUp += BONUS_MAX; bonusAt = t; }
  let clamped = false;
  if (s > acc.score + maxUp) { s = acc.score + maxUp; clamped = true; }
  await env.DB.prepare('UPDATE accounts SET score = ?, score_ts = ?, last_access = ?, bonus_ts = ? WHERE id = ?').bind(s, t, minuteStamp(), bonusAt, acc.id).run();
  let rank = null;
  if (s > 0) rank = (await env.DB.prepare('SELECT COUNT(*) AS c FROM accounts WHERE score > ?').bind(s).first()).c + 1;
  return json(request, env, { score: s, clamped, rank });
}

async function ranking(request, env) {
  const { results } = await env.DB.prepare('SELECT name, score FROM accounts WHERE score > 0 ORDER BY score DESC, score_ts ASC LIMIT 10').all();
  return json(request, env, results || [], 200, { 'Cache-Control': 'public, max-age=5' });
}

async function me(request, env) {
  const acc = await authenticate(request, env);
  if (!acc) return fail(request, env, 401, 'unauthorized');
  await env.DB.prepare('UPDATE accounts SET last_access = ? WHERE id = ?').bind(minuteStamp(), acc.id).run();
  return json(request, env, { account: publicAccount(acc) });
}

async function logout(request, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256b64(m[1])).run();
  return json(request, env, { ok: true });
}

// アカウント削除（パスワード証明が必要）。ランキングからも即消える。
async function deleteAccount(request, env, body) {
  const acc = await authenticate(request, env);
  if (!acc) return fail(request, env, 401, 'unauthorized');
  if (!B64URL_43.test(body.pw || '')) return fail(request, env, 400, 'bad_secret');
  const t = nowSec();
  if (acc.lock_pw_until > t) return fail(request, env, 429, 'locked', { retry_after: acc.lock_pw_until - t });
  if (!safeEqual(await hmacB64(env.PEPPER, `pw|${acc.pw_salt}|${body.pw}`), acc.pw_hash)) {
    const n = acc.fail_pw + 1; const sec = lockSeconds(n, 5, 30, 3600);
    await env.DB.prepare('UPDATE accounts SET fail_pw = ?, lock_pw_until = ? WHERE id = ?').bind(n, sec ? t + sec : 0, acc.id).run();
    return fail(request, env, 401, 'invalid_credentials');
  }
  await env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(acc.id).run();
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(acc.id).run();
  return json(request, env, { ok: true });
}

async function cleanup(env) {
  const t = nowSec();
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(t).run();
  const cutoff = t - INACTIVE_DAYS * 86400;
  await env.DB.prepare('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE last_access < ?)').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM accounts WHERE last_access < ?').bind(cutoff).run();
}

const POST_ROUTES = { '/api/register': register, '/api/login': login, '/api/score': postScore, '/api/delete': deleteAccount };

async function handle(request, env) {
  if (!env.PEPPER || String(env.PEPPER).length < 16) return fail(request, env, 500, 'server_not_configured');
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const originOk = allowedOrigin(request, env);

  if (request.method === 'OPTIONS') {
    if (!originOk) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': originOk, 'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400' } });
  }
  if (origin && !originOk) return fail(request, env, 403, 'origin_not_allowed');

  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'GET') {
    if (path === '/api/ranking') return ranking(request, env);
    if (path === '/api/me') return me(request, env);
    if (path === '/' || path === '/api/health') return json(request, env, { ok: true });
    return fail(request, env, 404, 'not_found');
  }
  if (request.method === 'POST') {
    if (path === '/api/logout') return logout(request, env);
    const fn = POST_ROUTES[path];
    if (!fn) return fail(request, env, 404, 'not_found');
    const body = await readJson(request);
    if (body.tooLarge) return fail(request, env, 413, 'too_large');
    if (body.bad) return fail(request, env, 400, 'bad_json');
    return fn(request, env, body.v);
  }
  return fail(request, env, 405, 'method_not_allowed');
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch { return fail(request, env, 500, 'server_error'); } // 例外内容・リクエスト内容はログに出さない
  },
  async scheduled(_event, env) { await cleanup(env); },
};
