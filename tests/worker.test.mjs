// 実際の worker/src/index.js を、D1互換のSQLite(node:sqlite)に繋いでAPI全体を検証する。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/src/index.js';
import { createWorkerApi, deriveSecret, ApiError } from '../js/api.js';
const memStore = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), del: (k) => m.delete(k) }; };

const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(schema); }
  prepare(sql) {
    const st = this.db.prepare(sql);
    const mk = (a) => ({
      first: async () => st.get(...a) ?? null,
      run: async () => { st.run(...a); return { success: true }; },
      all: async () => ({ results: st.all(...a).map((r) => ({ ...r })) }),
    });
    return { bind: (...a) => mk(a), ...mk([]) };
  }
}
const ORIGIN = 'https://example-user.github.io';
const env = { DB: new D1(), PEPPER: 'test-pepper-0123456789abcdef', ALLOWED_ORIGINS: ORIGIN, ALLOW_LOCALHOST: '0' };

// 送信されたリクエストを全て記録（プライバシー検査用）
const seen = [];
const fetchImpl = async (url, init) => {
  const headers = { Origin: ORIGIN, ...(init.headers || {}) };
  seen.push({ url, init: { ...init } });
  const req = new Request(url, { method: init.method, headers, body: init.body });
  return worker.fetch(req, env);
};
const api = () => createWorkerApi('https://api.example.workers.dev', { fetchImpl, storage: memStore() });
const raw = (method, path, { body, headers = {}, origin = ORIGIN } = {}) =>
  worker.fetch(new Request('https://api.example.workers.dev' + path, { method, headers: { ...(origin ? { Origin: origin } : {}), ...headers }, body: body && JSON.stringify(body) }), env);
const rejects = async (p, code) => { try { await p; } catch (e) { assert.ok(e instanceof ApiError, String(e)); assert.equal(e.code, code, `expected ${code} got ${e.code}`); return e; } assert.fail(`expected ${code}`); };
const dbq = (sql, ...a) => env.DB.db.prepare(sql).all(...a);
const setNow = (sec) => { Date.now = () => sec * 1000; };
const realNow = Date.now.bind(Date);
const T0 = Math.floor(realNow() / 1000);

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok -', name); };

await t('登録→ログイン→ランキング→ログアウト', async () => {
  setNow(T0);
  const a = api();
  const r = await a.register('淫夢潜', 'correct horse battery');
  assert.equal(r.account.name, '淫夢潜'); assert.equal(r.account.score, 0); assert.match(r.account.id, /^[2-9A-HJ-NP-Z]{10}$/);
  assert.ok(a.token.length === 43);
  assert.equal((await a.restore()).name, '淫夢潜');
  const b = api(); const l = await b.login('淫夢潜', 'correct horse battery');
  assert.equal(l.account.id, r.account.id);
  await a.logout(); assert.equal(await a.restore(), null);
  assert.equal((await b.restore()).id, r.account.id); // 他セッションは生きている
});

await t('名前の重複は大小・全半角を無視して拒否 / 個人情報っぽい名前・不正な名前を拒否', async () => {
  const a = api();
  await a.register('Taro', 'password-1234');
  await rejects(api().register('ＴＡＲＯ', 'password-1234'), 'name_taken');
  await rejects(api().register('taro', 'password-1234'), 'name_taken');
  await rejects(api().register('me@example.com', 'password-1234'), 'name_looks_personal');
  await rejects(api().register('09012345678', 'password-1234'), 'name_looks_personal');
  await rejects(api().register('', 'password-1234'), 'bad_name');
  await rejects(api().register('あ'.repeat(17), 'password-1234', 'xx'), 'bad_name');
  await rejects(api().register('a​b', 'password-1234'), 'bad_name'); // ゼロ幅文字
  const ok = await api().register('  山田   太郎 ', 'password-1234'); assert.equal(ok.account.name, '山田 太郎'); // 空白は整形される
  await rejects(api().register('see https://x.y', 'password-1234'), 'name_looks_personal');
});

await t('生のパスワードはサーバーに送られず、DBにも入らない', async () => {
  seen.length = 0;
  const a = api();
  await a.register('Privacy', 'MySecretPassw0rd!');
  await a.login('Privacy', 'MySecretPassw0rd!');
  const wire = JSON.stringify(seen.map((s) => [s.url, s.init.headers, s.init.body]));
  assert.ok(!wire.includes('MySecretPassw0rd'), '生パスワードが通信に含まれている');
  const dump = JSON.stringify(dbq('SELECT * FROM accounts')) + JSON.stringify(dbq('SELECT * FROM sessions'));
  assert.ok(!dump.includes('MySecretPassw0rd'));
  const sent = JSON.parse(seen[0].init.body); assert.match(sent.pw, /^[A-Za-z0-9_-]{43}$/); assert.deepEqual(Object.keys(sent).sort(), ['name', 'pw']);
  // fetch に cookie/referrer を持たせない指定になっている
  for (const s of seen) { assert.equal(s.init.credentials, 'omit'); assert.equal(s.init.referrerPolicy, 'no-referrer'); }
  // トークンは生のまま保存されない（sessions にはハッシュのみ）
  assert.ok(!dbq('SELECT token_hash FROM sessions').some((r) => r.token_hash === a.token));
});

await t('DBの列に個人情報になり得るものが無い（IP/UA/メール/秒単位時刻）', async () => {
  const cols = dbq("SELECT name FROM pragma_table_info('accounts')").map((r) => r.name).join(',');
  assert.ok(!/ip|agent|mail|ua\b|referer/i.test(cols), cols);
  const row = dbq("SELECT last_access FROM accounts WHERE name_key='privacy'")[0];
  assert.equal(row.last_access % 60, 0, '最終アクセスは分に丸める');
  // サーバーコードが IP/UA/Cookie ヘッダを読んでいない
  const src = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/CF-Connecting-IP|x-forwarded-for|user-agent|cf\.|request\.headers\.get\('cookie|console\.(log|info|warn|error)/i.test(src));
});

await t('パスワード間違いは一般的なエラー。5回失敗でロック、正しくてもロック中は拒否', async () => {
  setNow(T0 + 100);
  const a = api(); await a.register('Locky', 'right-password-1');
  for (let i = 0; i < 5; i++) await rejects(api().login('Locky', 'wrong-password-' + i), 'invalid_credentials');
  const e = await rejects(api().login('Locky', 'right-password-1'), 'locked'); assert.ok(e.retryAfter > 0 && e.retryAfter <= 30);
  await rejects(api().login('NoSuchUser', 'whatever-1234'), 'invalid_credentials'); // 存在しない名前も同じ応答
  setNow(T0 + 100 + 31);
  await api().login('Locky', 'right-password-1');                                      // 時間が経てば解除・成功で失敗回数リセット
  assert.equal(dbq("SELECT fail_pw FROM accounts WHERE name_key='locky'")[0].fail_pw, 0);
});

await t('点数: 加算は経過時間ぶんまで（チート抑止）／減算(動画削除イベント)は自由／順位が返る', async () => {
  setNow(T0 + 5000);
  const a = api(); await a.register('Scorer', 'score-password-1');
  setNow(T0 + 5010);                                  // 10秒後
  let r = await a.score(1000); assert.equal(r.score, 1000); assert.equal(r.clamped, false); assert.equal(r.rank, 1);
  setNow(T0 + 5011);
  r = await a.score(9_999_999); assert.equal(r.clamped, true); assert.ok(r.score <= 1000 + Math.round(100 * 1 * 1.25) + 50, `score=${r.score}`);
  setNow(T0 + 5100);
  r = await a.score(r.score - 114514); assert.equal(r.score < 0, true); assert.equal(r.rank, null); assert.equal(r.clamped, false);
  await rejects(a.score(NaN), 'bad_score');
  const rk = await a.ranking(); assert.ok(!rk.some((x) => x.name === 'Scorer'), '0点以下はランキングに載らない');
});

await t('完走ボーナス: bonus:true なら まとまった加点を1回だけ許可（200秒の間隔）／無しなら従来どおり制限', async () => {
  setNow(T0 + 40000);
  const a = api(); await a.register('Bonuser', 'bonus-password-1');
  setNow(T0 + 40010); await a.score(1000);
  setNow(T0 + 40020);
  let r = await a.score(1000 + 20000); assert.equal(r.clamped, true, 'bonus無しでは制限される');
  const base = r.score;
  r = await a.score(base + 20000, { bonus: true }); assert.equal(r.clamped, false); assert.equal(r.score, base + 20000);
  setNow(T0 + 40030);
  r = await a.score(r.score + 20000, { bonus: true }); assert.equal(r.clamped, true, '200秒以内の2回目は制限される');
  setNow(T0 + 40030 + 201);
  r = await a.score(r.score + 20000, { bonus: true }); assert.equal(r.clamped, false, '間隔が空けば再び許可');
  r = await a.score(r.score + 90000, { bonus: true }); assert.equal(r.clamped, true, 'ボーナスでも上限(30000)を超えられない');
  assert.ok(dbq("SELECT bonus_ts FROM accounts WHERE name_key='bonuser'")[0].bonus_ts > 0);
  await a.score(0); // 後続のランキング検証に影響しないよう戻す
});

await t('徳政令カード: マイナス→ちょうど0だけ許可（0を超える加点・フラグ無しは従来どおり制限）', async () => {
  setNow(T0 + 50000);
  const a = api(); await a.register('Debtor', 'debtor-password-1'); setNow(T0 + 50010);
  let r = await a.score(-114514); assert.equal(r.score, -114514);
  setNow(T0 + 50011);
  r = await a.score(0); assert.equal(r.clamped, true, 'フラグ無しの回復は加点速度で制限される');
  r = await a.score(0, { tokusei: true }); assert.equal(r.score, 0); assert.equal(r.clamped, false);
  r = await a.score(5000, { tokusei: true }); assert.equal(r.clamped, true, '0を超える加点には使えない');
  const b = api(); await b.register('Plusman', 'plus-password-1'); setNow(T0 + 50030); await b.score(100);
  setNow(T0 + 50031); r = await b.score(0, { tokusei: true }); assert.equal(r.score, 0);
  setNow(T0 + 50032); await a.score(0);
});

await t('ランキング: 上位10件・点数降順・名前と点数だけ（IDや時刻を返さない）', async () => {
  setNow(T0 + 9000);
  for (let i = 0; i < 12; i++) {
    const a = api(); await a.register('Rank' + i, 'rank-password-' + i);
    setNow(T0 + 9000 + 200 + i); await a.score(10 + i * 7);
  }
  const rk = await api().ranking();
  assert.equal(rk.length, 10);
  for (let i = 1; i < rk.length; i++) assert.ok(rk[i - 1].score >= rk[i].score);
  assert.deepEqual(Object.keys(rk[0]).sort(), ['name', 'score']);
  assert.equal(rk[0].name, 'Rank11');
});

await t('アカウント削除: パスワード必須、削除後はランキング・ログイン不可', async () => {
  setNow(T0 + 20000);
  const a = api(); await a.register('Goner', 'gone-password-1'); setNow(T0 + 20100); await a.score(500);
  await rejects(a.deleteAccount('Goner', 'wrong-password-1'), 'invalid_credentials');
  await a.deleteAccount('Goner', 'gone-password-1');
  await rejects(api().login('Goner', 'gone-password-1'), 'invalid_credentials');
  assert.ok(!(await api().ranking()).some((x) => x.name === 'Goner'));
  assert.equal(dbq("SELECT COUNT(*) c FROM sessions WHERE account_id NOT IN (SELECT id FROM accounts)")[0].c, 0);
});

await t('180日アクセスの無いアカウントは掃除で消える', async () => {
  setNow(T0 + 30000);
  await api().register('Stale', 'stale-password-1');
  setNow(T0 + 30000 + 181 * 86400);
  await worker.scheduled({}, env);
  assert.equal(dbq("SELECT COUNT(*) c FROM accounts WHERE name_key='stale'")[0].c, 0);
  setNow(T0);
});

await t('CORS: 許可オリジン以外は拒否、プリフライト対応、Cookie不使用', async () => {
  let r = await raw('GET', '/api/ranking', { origin: 'https://evil.example' }); assert.equal(r.status, 403);
  r = await raw('OPTIONS', '/api/login', { origin: 'https://evil.example' }); assert.equal(r.status, 403);
  r = await raw('OPTIONS', '/api/login'); assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  r = await raw('GET', '/api/ranking'); assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

await t('入力の異常: 巨大ボディ/壊れたJSON/メソッド違い/PEPPER未設定/生の短い秘密', async () => {
  let r = await worker.fetch(new Request('https://x/api/login', { method: 'POST', headers: { Origin: ORIGIN, 'content-length': '999999' }, body: '{}' }), env); assert.equal(r.status, 413);
  r = await worker.fetch(new Request('https://x/api/login', { method: 'POST', headers: { Origin: ORIGIN }, body: '{oops' }), env); assert.equal(r.status, 400);
  r = await raw('PUT', '/api/login'); assert.equal(r.status, 405);
  r = await raw('POST', '/api/register', { body: { name: 'Short', pw: 'plain' } }); assert.equal(r.status, 400); // 生の短い文字列は受け付けない
  r = await worker.fetch(new Request('https://x/api/ranking'), { ...env, PEPPER: '' }); assert.equal(r.status, 500);
  r = await raw('POST', '/api/score', { body: { score: 5 } }); assert.equal(r.status, 401);
});

await t('登録スパム抑制: 同じ1時間に REG_PER_HOUR 件まで（IPは使わない）', async () => {
  setNow(T0 + 400 * 86400); // 新しい時間帯
  const e2 = { ...env, REG_PER_HOUR: '3' };
  const f2 = async (url, init) => worker.fetch(new Request(url, { method: init.method, headers: { Origin: ORIGIN, ...init.headers }, body: init.body }), e2);
  const mk = () => createWorkerApi('https://x', { fetchImpl: f2, storage: memStore() });
  for (let i = 0; i < 3; i++) await mk().register('Spam' + i, 'spam-password-1');
  const e = await rejects(mk().register('Spam3', 'spam-password-1'), 'busy'); assert.ok(e.retryAfter > 0);
  setNow(T0 + 400 * 86400 + 3601); await mk().register('Spam3', 'spam-password-1'); // 次の時間帯なら通る
  setNow(T0);
});

await t('クライアント導出: 同じ入力→同じ値、名前/秘密が違えば別の値（Node/ブラウザ共通のWebCrypto）', async () => {
  const a = await deriveSecret('abc12345', 'Taro'), b = await deriveSecret('abc12345', 'ＴＡＲＯ'); // 名前は正規化される
  assert.equal(a, b);
  assert.notEqual(a, await deriveSecret('abc12346', 'Taro'));
  assert.notEqual(a, await deriveSecret('abc12345', 'Jiro'));
});

console.log(`\n${n} tests passed`);
