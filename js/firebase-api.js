// Firebase版バックエンド（Authentication + Cloud Firestore）。GitHub Pagesだけで完結する構成。
//
// ・ログイン: Firebase Authのメール/パスワード方式を、「ユーザー名のハッシュ@偽ドメイン」で代用。
//   利用者がメールアドレスを入力することはなく、実在しないドメインなのでメールは一切送られない。
// ・パスワード: ブラウザ内でPBKDF2(15万回)した値をFirebaseに渡す（生のパスワードはGoogleにも届かない）。
// ・点数: Firestoreの players/{uid} に {name, nameKey, score, ts, expireAt}。
//   書き込みの正当性（本人のみ・加点速度の上限）は firebase/firestore.rules が強制する。
// ・映像・画像・ポーズ座標は一切送らない。
import { ApiError, deriveSecret, normName, cleanName, looksPersonal } from './api.js';

export const SDK_VERSION = '10.12.2';
const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
export const EMAIL_DOMAIN = 'hant-inmu.example';
const EXPIRE_MS = 180 * 86400 * 1000; // 180日アクセスが無ければ（TTLを設定した場合）自動削除

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function nameKeyOf(name) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(normName(name)))).slice(0, 32); }

async function loadSdk() {
  try {
    const [app, auth, fs] = await Promise.all([import(`${SDK_BASE}firebase-app.js`), import(`${SDK_BASE}firebase-auth.js`), import(`${SDK_BASE}firebase-firestore.js`)]);
    return { app, auth, fs };
  } catch { throw new ApiError('network', 0); }
}

function mapAuthError(e) {
  if (e instanceof ApiError) return e;
  const c = (e && e.code) || '';
  if (c === 'auth/email-already-in-use') return new ApiError('name_taken', 409);
  if (['auth/invalid-credential', 'auth/user-not-found', 'auth/wrong-password', 'auth/invalid-login-credentials', 'auth/invalid-email'].includes(c)) return new ApiError('invalid_credentials', 401);
  if (c === 'auth/too-many-requests') return new ApiError('locked', 429, 300);
  if (c === 'auth/network-request-failed') return new ApiError('network', 0);
  if (['auth/operation-not-allowed', 'auth/configuration-not-found', 'auth/invalid-api-key', 'auth/api-key-not-valid.-please-pass-a-valid-api-key.', 'auth/app-not-authorized'].includes(c)) return new ApiError('setup_error', 400);
  if (['auth/requires-recent-login', 'auth/user-token-expired', 'auth/user-disabled', 'auth/user-not-found'].includes(c)) return new ApiError('unauthorized', 401);
  return new ApiError('server_error', 500);
}
function mapFsError(e) {
  if (e instanceof ApiError) return e;
  const c = (e && e.code) || '';
  if (c === 'permission-denied') return new ApiError('setup_error', 403);
  if (c === 'unavailable' || c === 'deadline-exceeded') return new ApiError('network', 0);
  if (c === 'unauthenticated') return new ApiError('unauthorized', 401);
  return new ApiError('server_error', 500);
}

export function createFirebaseApi(firebaseConfig, { sdk: injected } = {}) {
  let ctx = null;
  async function init() {
    if (ctx) return ctx;
    const sdk = injected || await loadSdk();
    const app = sdk.app.initializeApp(firebaseConfig);
    ctx = { sdk, auth: sdk.auth.getAuth(app), db: sdk.fs.getFirestore(app) };
    return ctx;
  }
  const expireAt = (fs) => fs.Timestamp.fromMillis(Date.now() + EXPIRE_MS);
  const playerRef = ({ sdk, db }, uid) => sdk.fs.doc(db, 'players', uid);

  // players/{uid} を読む。無ければ（TTLで消えた場合など）作り直す。あれば最終アクセスを更新。
  async function ensurePlayer(c, user, nameForCreate) {
    const { fs } = c.sdk, ref = playerRef(c, user.uid);
    let snap;
    try { snap = await fs.getDoc(ref); } catch (e) { throw mapFsError(e); }
    if (snap.exists()) {
      const d = snap.data();
      try { await fs.updateDoc(ref, { score: d.score, ts: fs.serverTimestamp(), expireAt: expireAt(fs) }); } catch { /* 最終アクセス更新の失敗は無視 */ }
      return { id: user.uid, name: d.name, score: d.score };
    }
    if (!nameForCreate) return null;
    try { await fs.setDoc(ref, { name: nameForCreate, nameKey: await nameKeyOf(nameForCreate), score: 0, ts: fs.serverTimestamp(), expireAt: expireAt(fs) }); }
    catch (e) { throw mapFsError(e); }
    return { id: user.uid, name: nameForCreate, score: 0 };
  }
  const credsFor = async (name) => {
    const n = cleanName(name); if (!n) throw new ApiError('bad_name', 400);
    return { n, email: `${await nameKeyOf(n)}@${EMAIL_DOMAIN}` };
  };

  return {
    kind: 'firebase',
    enabled: true,
    limits: { submitMs: 15000, rankingPollMs: 60000 }, // 無料枠(読み取り5万/書き込み2万 毎日)に収めるため控えめ
    async restore() {
      const c = await init();
      const user = await new Promise((res) => { const off = c.sdk.auth.onAuthStateChanged(c.auth, (u) => { off(); res(u); }); });
      if (!user) return null;
      try {
        const acc = await ensurePlayer(c, user, null);
        if (!acc) { await c.sdk.auth.signOut(c.auth); return null; } // データが消えている→ログインし直しで復活
        return acc;
      } catch (e) { if (e instanceof ApiError && e.code === 'network') throw e; return null; }
    },
    async register(name, pw) {
      const c = await init(); const { n, email } = await credsFor(name);
      if (looksPersonal(n)) throw new ApiError('name_looks_personal', 400);
      let cred;
      try { cred = await c.sdk.auth.createUserWithEmailAndPassword(c.auth, email, await deriveSecret(pw, n)); }
      catch (e) { throw mapAuthError(e); }
      try { return { account: await ensurePlayer(c, cred.user, n) }; }
      catch (e) { try { await c.sdk.auth.deleteUser(cred.user); } catch { /* 後始末の失敗は無視 */ } throw e; }
    },
    async login(name, pw) {
      const c = await init(); const { n, email } = await credsFor(name);
      let cred;
      try { cred = await c.sdk.auth.signInWithEmailAndPassword(c.auth, email, await deriveSecret(pw, n)); }
      catch (e) { throw mapAuthError(e); }
      return { account: await ensurePlayer(c, cred.user, n) };
    },
    async score(value) {
      const c = await init(); const user = c.auth.currentUser; if (!user) throw new ApiError('unauthorized', 401);
      const { fs } = c.sdk, ref = playerRef(c, user.uid), v = Math.round(value);
      try { await fs.updateDoc(ref, { score: v, ts: fs.serverTimestamp(), expireAt: expireAt(fs) }); return { score: v, clamped: false, rank: null }; }
      catch (e) {
        if (e && e.code === 'permission-denied') { // 加点速度の上限を超えた等 → サーバー側の点数に合わせる
          let snap; try { snap = await fs.getDoc(ref); } catch (e2) { throw mapFsError(e2); }
          if (!snap.exists()) throw new ApiError('unauthorized', 401);
          return { score: snap.data().score, clamped: true, rank: null };
        }
        throw mapFsError(e);
      }
    },
    async ranking() {
      const c = await init(); const { fs } = c.sdk;
      try {
        const q = fs.query(fs.collection(c.db, 'players'), fs.where('score', '>', 0), fs.orderBy('score', 'desc'), fs.limit(10));
        const snap = await fs.getDocs(q);
        return snap.docs.map((d) => ({ name: d.data().name, score: d.data().score }));
      } catch (e) { throw mapFsError(e); }
    },
    async logout() { const c = await init(); await c.sdk.auth.signOut(c.auth); },
    async deleteAccount(name, pw) {
      const c = await init(); const user = c.auth.currentUser; if (!user) throw new ApiError('unauthorized', 401);
      const { n, email } = await credsFor(name);
      try {
        await c.sdk.auth.reauthenticateWithCredential(user, c.sdk.auth.EmailAuthProvider.credential(email, await deriveSecret(pw, n)));
        await c.sdk.fs.deleteDoc(playerRef(c, user.uid));
        await c.sdk.auth.deleteUser(user);
      } catch (e) { throw (e && e.code && String(e.code).startsWith('auth/')) ? mapAuthError(e) : mapFsError(e); }
    },
  };
}
