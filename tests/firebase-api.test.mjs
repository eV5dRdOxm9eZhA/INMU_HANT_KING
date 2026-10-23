// Firebase版クライアントを、メモリ上の偽SDKで検証する（本物のFirebaseには接続しない）。
// 偽SDKには firebase/firestore.rules と同じ規則（本人のみ・フィールド固定・加点上限・nameKey一致）を
// JSで写してあり、クライアントが「ルールを通る書き込み」だけを行うことを確かめる。
// ※ルール自体の文法・動作は、Firebaseコンソールの「ルールプレイグラウンド」で確認すること。
import assert from 'node:assert/strict';
import { createFirebaseApi, EMAIL_DOMAIN, nameKeyOf } from '../js/firebase-api.js';
import { ApiError } from '../js/api.js';

const SERVER_TS = Symbol('serverTimestamp');
class Fake {
  constructor() { this.users = new Map(); this.docs = new Map(); this.current = null; this.now = 1_800_000_000_000; this.denyCreate = false; this.fails = new Map(); this.seq = 0; }
  ts(ms) { return { __ts: ms, toMillis: () => ms }; }
  resolve(data) { const o = {}; for (const [k, v] of Object.entries(data)) o[k] = v === SERVER_TS ? this.ts(this.now) : v; return o; }
  deny() { const e = new Error('denied'); e.code = 'permission-denied'; return e; }
  validExpire(d) { const m = d.expireAt && d.expireAt.toMillis(); return typeof m === 'number' && m > this.now + 179 * 864e5 && m < this.now + 181 * 864e5; }
  sdk() {
    const F = this;
    const authObj = { get currentUser() { return F.current; } };
    const authErr = (code) => Object.assign(new Error(code), { code });
    return {
      app: { initializeApp: (cfg) => ({ cfg }) },
      auth: {
        getAuth: () => authObj,
        onAuthStateChanged: (_a, cb) => { setTimeout(() => cb(F.current), 0); return () => {}; },
        async createUserWithEmailAndPassword(_a, email, pw) {
          if (F.users.has(email)) throw authErr('auth/email-already-in-use');
          if (pw.length < 6) throw authErr('auth/weak-password');
          const u = { uid: 'uid' + (++F.seq), email, pw }; F.users.set(email, u); F.current = u; return { user: u };
        },
        async signInWithEmailAndPassword(_a, email, pw) {
          const n = F.fails.get(email) || 0; if (n >= 5) throw authErr('auth/too-many-requests');
          const u = F.users.get(email); if (!u || u.pw !== pw) { F.fails.set(email, n + 1); throw authErr('auth/invalid-credential'); }
          F.current = u; return { user: u };
        },
        async signOut() { F.current = null; },
        async deleteUser(u) { F.users.delete(u.email); if (F.current === u) F.current = null; },
        async reauthenticateWithCredential(u, cred) { if (u.email !== cred.email || u.pw !== cred.pw) throw authErr('auth/invalid-credential'); },
        EmailAuthProvider: { credential: (email, pw) => ({ email, pw }) },
      },
      fs: {
        getFirestore: () => ({}),
        doc: (_db, col, id) => ({ path: `${col}/${id}`, id }),
        collection: (_db, col) => ({ col }),
        where: (f, op, v) => ({ t: 'where', f, op, v }), orderBy: (f, d) => ({ t: 'orderBy', f, d }), limit: (n) => ({ t: 'limit', n }),
        query: (c, ...cons) => ({ ...c, cons }),
        serverTimestamp: () => SERVER_TS,
        Timestamp: { fromMillis: (ms) => F.ts(ms) },
        async getDoc(ref) {
          const d = F.docs.get(ref.path);
          if (!F.current || ref.id !== F.current.uid) throw F.deny(); // get は本人のみ
          return { exists: () => !!d, data: () => d };
        },
        async getDocs(q) {
          const lim = q.cons.find((c) => c.t === 'limit'); if (!lim || lim.n > 10) throw F.deny();
          let rows = [...F.docs.entries()].filter(([p]) => p.startsWith(q.col + '/')).map(([, d]) => d);
          for (const c of q.cons) if (c.t === 'where' && c.op === '>') rows = rows.filter((d) => d[c.f] > c.v);
          const ob = q.cons.find((c) => c.t === 'orderBy'); if (ob) rows.sort((a, b) => (ob.d === 'desc' ? b[ob.f] - a[ob.f] : a[ob.f] - b[ob.f]));
          return { docs: rows.slice(0, lim.n).map((d) => ({ data: () => d })) };
        },
        async setDoc(ref, data) { // = create（ルールの create 条件）
          const u = F.current; const keys = Object.keys(data).sort().join();
          const d = F.resolve(data);
          if (F.denyCreate || !u || ref.id !== u.uid || F.docs.has(ref.path) || keys !== 'expireAt,name,nameKey,score,ts'
            || typeof d.name !== 'string' || d.name.length < 1 || d.name.length > 64 || u.email !== `${d.nameKey}@${EMAIL_DOMAIN}`
            || d.score !== 0 || d.ts.toMillis() !== F.now || !F.validExpire(d)) throw F.deny();
          F.docs.set(ref.path, d);
        },
        async updateDoc(ref, data) { // = update の条件
          const u = F.current; const old = F.docs.get(ref.path); const d = F.resolve(data);
          if (!u || ref.id !== u.uid || !old) throw F.deny();
          if (Object.keys(data).some((k) => !['score', 'ts', 'expireAt'].includes(k))) throw F.deny();
          if (!Number.isInteger(d.score) || Math.abs(d.score) > 1e9 || d.ts.toMillis() !== F.now || !F.validExpire(d)) throw F.deny();
          const dt = Math.max(0, Math.min(3600000, F.now - old.ts.toMillis()));
          if ((d.score - old.score) * 1000 > dt * 125 + 50000) throw F.deny();
          F.docs.set(ref.path, { ...old, ...d });
        },
        async deleteDoc(ref) { if (!F.current || ref.id !== F.current.uid) throw F.deny(); F.docs.delete(ref.path); },
      },
    };
  }
}

const fresh = () => { const f = new Fake(); Date.now = () => f.now; /* クライアントの時計もテスト内の時刻に合わせる */ return { f, api: createFirebaseApi({ projectId: 'test' }, { sdk: f.sdk() }) }; };
const rejects = async (p, code) => { try { await p; } catch (e) { assert.ok(e instanceof ApiError, String(e && e.stack)); assert.equal(e.code, code, `expected ${code} got ${e.code}`); return e; } assert.fail(`expected ${code}`); };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok -', name); };

await t('登録: 偽メールでAuthユーザー作成 / 生パスワードは渡さない / players文書が規則どおり作られる', async () => {
  const { f, api } = fresh();
  const r = await api.register('淫夢潜', 'my-secret-password');
  assert.equal(r.account.name, '淫夢潜'); assert.equal(r.account.score, 0);
  const [email, user] = [...f.users.entries()][0];
  assert.equal(email, `${await nameKeyOf('淫夢潜')}@${EMAIL_DOMAIN}`);
  assert.match(email, /^[0-9a-f]{32}@hant-inmu\.example$/);
  assert.match(user.pw, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(user.pw, 'my-secret-password');
  const doc = f.docs.get(`players/${user.uid}`);
  assert.deepEqual(Object.keys(doc).sort(), ['expireAt', 'name', 'nameKey', 'score', 'ts']);
  assert.ok(!JSON.stringify([...f.docs.values()]).includes('my-secret-password'));
});
await t('名前の重複（大小・全半角）は拒否、不正/個人情報っぽい名前は拒否', async () => {
  const { api } = fresh();
  await api.register('Taro', 'password-1234');
  await rejects(api.register('ＴＡＲＯ', 'password-1234'), 'name_taken');
  await rejects(api.register('taro', 'password-1234'), 'name_taken');
  await rejects(api.register('me@example.com', 'password-1234'), 'name_looks_personal');
  await rejects(api.register('09012345678', 'password-1234'), 'name_looks_personal');
  await rejects(api.register('', 'password-1234'), 'bad_name');
  await rejects(api.register('a/b', 'password-1234'), 'bad_name');
  await rejects(api.register('あ'.repeat(17), 'password-1234'), 'bad_name');
});
await t('ログイン成否・ロック・ログアウト・復元（restore）', async () => {
  const { f, api } = fresh();
  await api.register('Login', 'password-1234'); await api.logout();
  assert.equal(await api.restore(), null);
  await rejects(api.login('Login', 'wrong-password'), 'invalid_credentials');
  await rejects(api.login('NoSuchUser', 'password-1234'), 'invalid_credentials');
  const r = await api.login('Login', 'password-1234'); assert.equal(r.account.name, 'Login');
  const again = await api.restore(); assert.equal(again.name, 'Login'); // 再訪問でログイン維持
  await api.logout();
  for (let i = 0; i < 5; i++) await rejects(api.login('Login', 'bad-' + i), i < 4 ? 'invalid_credentials' : 'invalid_credentials').catch(() => {});
  await rejects(api.login('Login', 'password-1234'), 'locked');
});
await t('点数: 速度内の加点はOK / 速すぎる加点は拒否されサーバー側の点に合わせる / 減点(-114514)は自由', async () => {
  const { f, api } = fresh();
  await api.register('Scorer', 'password-1234');
  f.now += 10_000;                                           // 10秒後
  let r = await api.score(1000); assert.deepEqual([r.score, r.clamped], [1000, false]);
  f.now += 1_000;
  r = await api.score(9_999_999); assert.equal(r.clamped, true); assert.equal(r.score, 1000); // 拒否→サーバー値
  f.now += 5_000; r = await api.score(1000 - 114514); assert.deepEqual([r.score, r.clamped], [-113514, false]);
  f.now += 60_000; r = await api.score(-113514 + 5000); assert.equal(r.clamped, false);
  f.now += 10 * 3600_000; r = await api.score(-108514 + 500_000); assert.equal(r.clamped, true, '1時間ぶんを超える加点は拒否');
});
await t('ランキング: 0点以下を除き降順・最大10件・名前と点数のみ', async () => {
  const { f, api } = fresh();
  for (let i = 0; i < 12; i++) { await api.register('Rank' + i, 'password-1234'); f.now += 20_000; await api.score(10 + i * 7); await api.logout(); }
  await api.register('Zero', 'password-1234'); await api.logout();
  const rk = await api.ranking();
  assert.equal(rk.length, 10); assert.equal(rk[0].name, 'Rank11');
  for (let i = 1; i < rk.length; i++) assert.ok(rk[i - 1].score >= rk[i].score);
  assert.deepEqual(Object.keys(rk[0]).sort(), ['name', 'score']);
  assert.ok(!rk.some((x) => x.name === 'Zero'));
});
await t('データ期限切れ(TTL)で文書が消えても、ログインし直すと復活する', async () => {
  const { f, api } = fresh();
  await api.register('Expired', 'password-1234'); await api.logout();
  f.docs.clear();                                           // TTLで消えた想定
  const again = await api.login('Expired', 'password-1234'); assert.equal(again.account.name, 'Expired'); assert.equal(again.account.score, 0);
  await api.logout(); f.docs.clear();
  assert.equal(await api.restore(), null);
});
await t('文書の作成がルールで拒否されたら、作りかけのAuthユーザーを後始末する', async () => {
  const { f, api } = fresh(); f.denyCreate = true;
  await rejects(api.register('Cleanup', 'password-1234'), 'setup_error');
  assert.equal(f.users.size, 0);
});
await t('アカウント削除: パスワード必須 / 正しければ文書とAuthユーザーが消える', async () => {
  const { f, api } = fresh();
  await api.register('Goner', 'password-1234');
  await rejects(api.deleteAccount('Goner', 'wrong-password'), 'invalid_credentials');
  assert.equal(f.users.size, 1); assert.equal(f.docs.size, 1);
  await api.deleteAccount('Goner', 'password-1234');
  assert.equal(f.users.size, 0); assert.equal(f.docs.size, 0);
  await rejects(api.login('Goner', 'password-1234'), 'invalid_credentials');
});
await t('Authのメール/パスワード方式が無効のとき、分かりやすい設定エラーになる', async () => {
  const f = new Fake(); const sdk = f.sdk();
  sdk.auth.createUserWithEmailAndPassword = async () => { throw Object.assign(new Error('x'), { code: 'auth/operation-not-allowed' }); };
  await rejects(createFirebaseApi({ projectId: 't' }, { sdk }).register('Setup', 'password-1234'), 'setup_error');
});
console.log(`\n${n} tests passed`);
