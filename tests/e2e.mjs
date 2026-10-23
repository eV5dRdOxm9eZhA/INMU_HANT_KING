// 実ブラウザ(Chromium)で、画面 + 実際のWorkerコード + D1互換SQLite をつないで通しで検証する。
// MediaPipe本体はこのテスト環境では取得できないため、偽の判定エンジンに差し替え、骨格データだけを外から与える。
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import worker from '../worker/src/index.js';

const requireFrom = (base) => createRequire(base);
let chromium;
for (const base of [import.meta.url, process.cwd() + '/', '/opt/npm-tools/node_modules/']) { try { ({ chromium } = requireFrom(base)('playwright')); break; } catch { /* 次の候補へ */ } }
if (!chromium) { console.error('playwright が見つかりません: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = process.env.SHOTS || join(tmpdir(), 'hant-shots');
mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const f = join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  const buf = readFileSync(f), type = MIME[extname(f)] || 'application/octet-stream', m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) { const a = m[1] ? +m[1] : 0, b = m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1; res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': b - a + 1 }); res.end(buf.subarray(a, b + 1)); return; } // 音声のシークに必要（GitHub Pagesも対応）
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': buf.length }); res.end(buf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port, BASE = `http://127.0.0.1:${PORT}`;

// ---- D1互換 ----
const schema = readFileSync(join(ROOT, 'worker/schema.sql'), 'utf8');
const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema);
const DB = { prepare(sql) { const st = sqlite.prepare(sql); const mk = (a) => ({ first: async () => st.get(...a) ?? null, run: async () => { st.run(...a); return {}; }, all: async () => ({ results: st.all(...a).map((r) => ({ ...r })) }) }); return { bind: (...a) => mk(a), ...mk([]) }; } };
const env = { DB, PEPPER: 'e2e-pepper-0123456789abcdef', ALLOWED_ORIGINS: BASE };
const apiLog = []; // サーバーに届いたリクエスト全記録（プライバシー検査用）

const FAKE_VISION = `
export const FilesetResolver = { forVisionTasks: async () => ({}) };
export const PoseLandmarker = { createFromOptions: async () => ({
  detectForVideo() { const lm = window.__fakeLm; return { landmarks: lm ? [lm] : [] }; },
  close() {} }) };`;
const POSE = (() => { // 淫夢ポーズ（両手を頭の後ろ・肘を外へ）
  const lm = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: 1 }));
  lm[0] = { x: .5, y: .33, visibility: 1 }; lm[11] = { x: .61, y: .55, visibility: 1 }; lm[12] = { x: .39, y: .55, visibility: 1 };
  lm[13] = { x: .77, y: .45, visibility: 1 }; lm[14] = { x: .23, y: .45, visibility: 1 }; lm[15] = { x: .54, y: .34, visibility: 1 }; lm[16] = { x: .46, y: .34, visibility: 1 };
  return lm;
})();


// ---- ブラウザ内で動く偽Firebase SDK（localStorageに保存。リロード後の「ログイン保持」も再現）----
const FAKE_FB = {
  'firebase-app.js': `export const initializeApp = (c) => ({ c });`,
  'firebase-auth.js': `
const KEY='__fake_fb'; const load=()=>JSON.parse(localStorage.getItem(KEY)||'{"users":{},"docs":{},"cur":null,"seq":0}'); const save=(d)=>localStorage.setItem(KEY,JSON.stringify(d));
const err=(code)=>Object.assign(new Error(code),{code});
const me=(d)=>{ if(!d.cur) return null; const u=Object.values(d.users).find(x=>x.uid===d.cur); return u?{uid:u.uid,email:u.email}:null; };
export const getAuth=()=>({ get currentUser(){ return me(load()); } });
export const onAuthStateChanged=(a,cb)=>{ setTimeout(()=>cb(a.currentUser),0); return ()=>{}; };
export const createUserWithEmailAndPassword=async(a,email,pw)=>{ const d=load(); if(d.users[email]) throw err('auth/email-already-in-use'); const uid='u'+(++d.seq); d.users[email]={uid,email,pw}; d.cur=uid; save(d); return {user:{uid,email}}; };
export const signInWithEmailAndPassword=async(a,email,pw)=>{ const d=load(); const u=d.users[email]; if(!u||u.pw!==pw) throw err('auth/invalid-credential'); d.cur=u.uid; save(d); return {user:{uid:u.uid,email}}; };
export const signOut=async()=>{ const d=load(); d.cur=null; save(d); };
export const deleteUser=async(u)=>{ const d=load(); for(const k of Object.keys(d.users)) if(d.users[k].uid===u.uid) delete d.users[k]; d.cur=null; save(d); };
export const reauthenticateWithCredential=async(u,c)=>{ const d=load(); if(d.users[c.e]?.pw!==c.p) throw err('auth/invalid-credential'); };
export const EmailAuthProvider={credential:(e,p)=>({e,p})};`,
  'firebase-firestore.js': `
const KEY='__fake_fb'; const load=()=>JSON.parse(localStorage.getItem(KEY)||'{"users":{},"docs":{},"cur":null,"seq":0}'); const save=(d)=>localStorage.setItem(KEY,JSON.stringify(d));
const TS=Symbol('ts'); const ts=(ms)=>({__ts:ms,toMillis:()=>ms});
const enc=(o)=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k, v===TS?{__ts:Date.now()}: (v&&v.__ts!==undefined?{__ts:v.__ts}:v)]));
const dec=(o)=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,(v&&v.__ts!==undefined)?ts(v.__ts):v]));
export const getFirestore=()=>({}); export const doc=(db,col,id)=>({path:col+'/'+id,id}); export const collection=(db,col)=>({col});
export const where=(f,op,v)=>({t:'w',f,op,v}); export const orderBy=(f,d)=>({t:'o',f,d}); export const limit=(n)=>({t:'l',n}); export const query=(c,...cons)=>({...c,cons});
export const serverTimestamp=()=>TS; export const Timestamp={fromMillis:ts};
export const getDoc=async(r)=>{ const v=load().docs[r.path]; return {exists:()=>!!v,data:()=>v&&dec(v)}; };
export const getDocs=async(q)=>{ let rows=Object.entries(load().docs).filter(([p])=>p.startsWith(q.col+'/')).map(([,v])=>dec(v)); for(const c of q.cons) if(c.t==='w'&&c.op==='>') rows=rows.filter(d=>d[c.f]>c.v); const o=q.cons.find(c=>c.t==='o'); if(o) rows.sort((a,b)=>b[o.f]-a[o.f]); return {docs:rows.slice(0,q.cons.find(c=>c.t==='l').n).map(d=>({data:()=>d}))}; };
export const setDoc=async(r,data)=>{ const d=load(); d.docs[r.path]=enc(data); save(d); };
export const updateDoc=async(r,data)=>{ const d=load(); d.docs[r.path]={...d.docs[r.path],...enc(data)}; save(d); };
export const deleteDoc=async(r)=>{ const d=load(); delete d.docs[r.path]; save(d); };`,
};

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function newPage(viewport, { api = true, query = '', firebase = false } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera'], hasTouch: viewport.width < 1000, isMobile: viewport.width < 1000 && viewport.width > 0 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const external = []; // サイト外(自サイト・テスト用API以外)へのリクエスト
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== BASE && u.origin !== 'https://api.test' && !(firebase && u.origin === 'https://www.gstatic.com') && u.protocol.startsWith('http')) external.push(r.url()); });
  await page.route('**/vendor/mediapipe/vision_bundle.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_VISION }));
  await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: firebase ? `window.HANT_CONFIG={backend:'firebase',firebase:{projectId:'fake',apiKey:'x'}};` : `window.HANT_CONFIG={apiBase:${api ? '"https://api.test"' : '""'}};` }));
  await page.route('https://www.gstatic.com/firebasejs/**', (r) => { const f = r.request().url().split('/').pop(); r.fulfill({ contentType: 'text/javascript', body: FAKE_FB[f] || '' }); });
  await page.route('https://api.test/**', async (route) => {
    const q = route.request(); const url = new URL(q.url());
    const headers = q.headers(); apiLog.push({ method: q.method(), path: url.pathname, headers, body: q.postData() });
    const req = new Request(q.url(), { method: q.method(), headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(q.method()) ? undefined : q.postData() });
    const res = await worker.fetch(req, env);
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  await page.goto(`${BASE}/${query}`); await page.evaluate(() => window.__hant8Ready);
  return { page, ctx, errors, external };
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok -', name); };
const noOverflow = async (page, label) => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight }));
  assert.ok(m.sw <= m.iw + 1, `${label}: 横スクロールが発生 ${m.sw}>${m.iw}`);
  return m;
};

try {
  // ====== 1. 登録〜起動 ======
  const A = await newPage({ width: 1280, height: 720 }, { query: '?fast' });
  const pg = A.page;
  await t('起動画面: プライバシー表示とログイン/登録/再設定/ゲストのタブがある', async () => {
    assert.match(await pg.textContent('.privacy-list'), /端末の中だけ/);
    for (const id of ['tabLogin', 'tabRegister', 'tabGuest']) assert.ok(await pg.isVisible('#' + id));
    await shot(pg, '01-login-desktop');
  });
  await t('新規登録 → 準備完了表示 → ログイン保持', async () => {
    await pg.click('#tabRegister');
    await pg.fill('#regName', '淫夢潜テスト'); await pg.fill('#regPw', 'password-1234');
    await shot(pg, '02-register-desktop');
    await pg.click('#formRegister button[type=submit]');
    await pg.waitForSelector('#readyView:not([hidden])', { timeout: 15000 });
    assert.match(await pg.textContent('#whoBox'), /淫夢潜テスト/);
    assert.ok(await pg.evaluate(() => localStorage.getItem('hant8_token')?.length === 43));
    await shot(pg, '03-ready-desktop');
  });
  await t('生のパスワード/合言葉が通信に含まれない・映像関連データが送信されない', async () => {
    const wire = JSON.stringify(apiLog.map((l) => [l.path, l.body]));
    assert.ok(!wire.includes('password-1234'));
    const reg = JSON.parse(apiLog.find((l) => l.path === '/api/register').body);
    assert.deepEqual(Object.keys(reg).sort(), ['name', 'pw']);
  });

  // ====== 2. 起動してポーズ ======
  await t('システム起動: 偽カメラで起動し、判定が成立するとスコアが増え背景が切り替わる', async () => {
    await pg.click('#startButton');
    await pg.waitForSelector('#startupOverlay', { state: 'hidden', timeout: 15000 });
    assert.equal(await pg.textContent('#poseText'), 'FALSE');
    await pg.evaluate((lm) => { window.__fakeLm = lm; }, POSE);
    await pg.waitForFunction(() => document.getElementById('poseText').textContent === 'TRUE', null, { timeout: 8000 });
    await pg.waitForFunction(() => document.getElementById('statusChip').textContent.includes('ポーズ中'), null, { timeout: 8000 });
    // 条件: ポーズを続けた時間が minPoseMs(fastは0.8秒)未満なら、カウントダウンが0でもイベントは起きない
    await pg.evaluate(() => { const e = window.__hant8.evt; e.poseRunMs = 0; e.nextInMs = 0; });
    await pg.waitForTimeout(300);
    assert.equal(await pg.evaluate(() => window.__hant8.evt.phase), 'idle', 'ポーズ継続が短いのにイベントが起きた');
    await pg.waitForFunction(() => /bg-after\.webp/.test(document.getElementById('backgroundImage').style.backgroundImage), null, { timeout: 4000 });
    const s0 = Number(await pg.textContent('#scoreText')); await pg.waitForTimeout(700);
    assert.ok(Number(await pg.textContent('#scoreText')) > s0, 'スコアが増えていない');
  });
  await t('動画削除イベント: ポーズ中(0.8秒=fast)以上で起き、アイコンが約1.5秒でうっすら→はっきり。警報音が鳴る', async () => {
    await pg.evaluate(() => { window.__osc = 0; const o = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.__osc++; return o.apply(this, arguments); }; });
    await pg.evaluate(() => { window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.getElementById('toast').textContent + '@' + Math.round(performance.now()))).observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true }); });
    const ops = [];
    await pg.waitForFunction(() => Number(document.getElementById('ytIcon').style.opacity) > 0.03, null, { timeout: 15000 });
    assert.ok(await pg.textContent('#statusChip').then((s) => s.includes('削除警告')));
    for (let i = 0; i < 2; i++) { ops.push(Number(await pg.evaluate(() => document.getElementById('ytIcon').style.opacity))); await pg.waitForTimeout(150); }
    assert.ok(ops[0] > 0 && ops[0] < 0.5, `最初はうっすら: ${ops}`);
    assert.ok(ops[1] > ops[0], `だんだんはっきり: ${ops}`);
    await pg.evaluate(() => { window.__fakeLm = null; window.__t0 = document.getElementById('music').currentTime; }); // 速やかにやめる → 回避の検証
    assert.equal(await pg.evaluate(() => window.__hant8.CFG.del.minPoseMs), 800, 'fast時の最短ポーズ時間');
    const before = Number(await pg.textContent('#scoreText')) + 0;
    try { await pg.waitForFunction(() => document.getElementById('toast').classList.contains('show') && /削除回避成功/.test(document.getElementById('toast').textContent), null, { timeout: 5000 }); } catch (e) { console.log('DBG', JSON.stringify(await pg.evaluate(() => ({ evt: window.__hant8.evt, toast: window.__toasts, pose: document.getElementById('poseText').textContent, chip: document.getElementById('statusChip').textContent, fake: !!window.__fakeLm }))));  throw e; }
    assert.match(await pg.textContent('#toast'), /もう一度ポーズをしてください！/);
    assert.equal(await pg.textContent('#poseText'), 'TRUE', '回避直後の1秒はポーズ中扱い');
    assert.equal(await pg.evaluate(() => document.getElementById('music').paused), false, '曲が止まっていない');
    await pg.waitForFunction(() => Number(getComputedStyle(document.getElementById('ytIcon')).opacity) < 0.05, null, { timeout: 3000 });
    const after = Number(await pg.textContent('#scoreText'));
    assert.ok(after >= before - 100, `回避なのに減点された: ${before} -> ${after}`);
    await shot(pg, '05-avoided-desktop');
    await pg.evaluate((lm) => { window.__fakeLm = lm; }, POSE);            // 1秒以内に構え直す
    await pg.waitForTimeout(1600);
    assert.ok(await pg.textContent('#statusChip').then((s) => s.includes('ポーズ中')), '構え直したのにポーズ切れになった');
    assert.ok(await pg.evaluate((t0) => document.getElementById('music').currentTime > t0, await pg.evaluate(() => window.__t0)), '曲が最初に戻った');
  });
  await t('回避後1秒以内に構え直さないとポーズ切れ（曲が最初に戻る）', async () => {
    await pg.waitForFunction(() => window.__hant8.evt.phase === 'warn', null, { timeout: 15000 });
    await pg.evaluate(() => { window.__fakeLm = null; });
    await pg.waitForFunction(() => /削除回避成功/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    await pg.waitForFunction(() => document.getElementById('statusChip').textContent.includes('未検出'), null, { timeout: 4000 });
    assert.match(await pg.textContent('#toast'), /途切れ/);
    await pg.evaluate((lm) => { window.__fakeLm = lm; }, POSE);
    await pg.waitForFunction(() => document.getElementById('statusChip').textContent.includes('ポーズ中'), null, { timeout: 8000 });
  });
  await t('被弾: アイコンがはっきりした時にポーズ中だと -114514点 + 警報音、サーバーにも反映', async () => {
    await pg.waitForSelector('#eventBanner.show', { timeout: 20000 });
    await shot(pg, '07-deleted-desktop');
    const s = Number(await pg.textContent('#scoreText'));
    assert.ok(s < -100000 && s > -125000, `点数が想定外: ${s}`);
    assert.match(await pg.textContent('#eventBanner'), /動画削除イベント/);
    assert.match(await pg.textContent('#eventPenalty'), /-114514/);
    assert.ok(await pg.evaluate(() => window.__osc) >= 1, '警報音が鳴っていない');
    await pg.waitForTimeout(1200);
    const row = sqlite.prepare("SELECT score FROM accounts WHERE name_key='淫夢潜テスト'").get();
    assert.ok(row.score < -100000, `サーバー側の点数が減っていない: ${row.score}`);
    assert.equal(await pg.evaluate(() => Math.round(Number(document.getElementById('ytIcon').style.opacity))), 0, '被弾後アイコンが消える');
  });
  await t('背景は曲の再生位置で10秒ごとに切り替わる（枚数が足りなければ繰り返す）', async () => {
    const info = await pg.evaluate(async () => { const m = document.getElementById('music'); await new Promise((r) => { if (m.readyState >= 1) r(); else { m.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 4000); } }); return { d: m.duration, playing: !m.paused }; });
    if (!(info.d > 0)) { console.log('    (このブラウザでは音声のメタデータが取れないため、再生位置の検証をスキップ)'); return; }
    for (const [sec, want] of [[2, /bg-after/], [12, /scene1/], [22, /scene2/], [32, /scene3/], [42, /scene4/], [52, /scene5/], [62, /bg-after/], [72, /scene1/]]) {
      await pg.evaluate((f) => { const m = document.getElementById('music'); m.currentTime = f; }, sec);
      try { await pg.waitForFunction((src) => new RegExp(src).test(document.getElementById('backgroundImage').style.backgroundImage), want.source, { timeout: 4000 }); }
      catch (e) { console.log('DBG', sec, await pg.evaluate(() => ({ bg: document.getElementById('backgroundImage').style.backgroundImage, t: document.getElementById('music').currentTime, d: document.getElementById('music').duration, paused: document.getElementById('music').paused, run: window.__hant8.run(), pose: document.getElementById('poseText').textContent }))); throw e; }
    }
  });
  await t('最後まで再生しきると、その回の獲得点が2倍（サーバーにも反映）', async () => {
    await pg.waitForFunction(() => window.__hant8.evt.phase === 'idle', null, { timeout: 10000 });
    await pg.evaluate(() => { window.__hant8.evt.nextInMs = 1e9; window.__hant8.markRun(); }); // 検証中は削除イベントを起こさない
    await pg.waitForTimeout(2500);
    const before = await pg.evaluate(() => window.__hant8.run());
    const gained = before.score - before.runStartScore; assert.ok(gained > 150, `獲得点が少なすぎ: ${gained}`);
    await pg.evaluate(() => document.getElementById('music').dispatchEvent(new Event('ended')));
    const after = await pg.evaluate(() => window.__hant8.run());
    assert.ok(Math.abs((after.score - before.score) - gained) < 60, `2倍になっていない: ${before.score} -> ${after.score} (獲得${gained})`);
    assert.match(await pg.textContent('#toast'), /完走ボーナス/);
    await pg.waitForTimeout(1500);
    const row = sqlite.prepare("SELECT score, bonus_ts FROM accounts WHERE name_key='淫夢潜テスト'").get();
    assert.ok(Math.abs(row.score - after.score) < 400, `サーバーに反映されていない(clamp?): server ${row.score} client ${after.score}`);
    assert.ok(row.bonus_ts > 0);
    assert.equal(await pg.evaluate(() => !document.getElementById('music').paused), true, '次の回が始まる');
  });
  await t('点数が負でもポーズで回復し、アイドルでは0未満から減らない', async () => {
    await pg.waitForTimeout(3600);
    const s0 = Number(await pg.textContent('#scoreText'));
    await pg.waitForTimeout(600);
    assert.ok(Number(await pg.textContent('#scoreText')) >= s0, '回復していない');
  });
  await t('設定パネル: 開閉・判定の甘さ・アカウント表示', async () => {
    await pg.click('#settingsOpen'); await pg.waitForSelector('#settingsPanel.open');
    assert.match(await pg.textContent('#settingsAccount'), /淫夢潜テスト[\s\S]*アカウントID/);
    assert.equal(await pg.inputValue('#levelSelect'), 'easy');
    await pg.waitForTimeout(400); await shot(pg, '08-settings-desktop');
    await pg.click('#settingsClose'); await pg.waitForFunction(() => !document.getElementById('settingsPanel').classList.contains('open'));
  });
  await t('停止 → 点数確定送信 / ログアウト後は別ユーザーとして扱われる', async () => {
    await pg.evaluate(() => { window.__fakeLm = null; });
    await pg.click('#stopButton');
    await pg.waitForSelector('#startupOverlay', { state: 'visible' });
    assert.ok(await pg.isVisible('#readyView'));
    await pg.click('#switchAccount'); await pg.waitForSelector('#authView:not([hidden])');
    assert.equal(await pg.evaluate(() => localStorage.getItem('hant8_token')), null);
  });
  await t('サイト外へのリクエストが無い（CDN・外部画像・フォント等に接続しない）', async () => {
    assert.deepEqual(A.external, []);
    const pageErrors = A.errors.filter((e) => !/Failed to load resource.*(404|403)/.test(e));
    assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
  });

  // ====== 3. ログイン・合言葉再設定・ランキング ======
  await t('ログイン(誤パスワードはエラー表示)→ ランキングに自分が強調表示され、前回の点数から再開する', async () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("UPDATE accounts SET score=4321, score_ts=? WHERE name_key='淫夢潜テスト'").run(now);
    await pg.click('#tabLogin');
    await pg.fill('#loginName', '淫夢潜テスト'); await pg.fill('#loginPw', 'wrong-password'); await pg.click('#formLogin button[type=submit]');
    await pg.waitForSelector('#authMsg.show.err'); assert.match(await pg.textContent('#authMsg'), /違います/);
    await pg.fill('#loginPw', 'password-1234'); await pg.click('#formLogin button[type=submit]');
    await pg.waitForSelector('#readyView:not([hidden])', { timeout: 15000 });
    assert.match(await pg.textContent('#whoBox'), /4321/);
    await pg.click('#startButton'); await pg.waitForSelector('#startupOverlay', { state: 'hidden', timeout: 15000 });
    await pg.waitForFunction(() => document.querySelector('#rankingBar .ranking-cell:not(.empty)'), null, { timeout: 8000 });
    assert.match(await pg.textContent('#rankingBar .ranking-cell'), /淫夢潜テスト.*4321|4321.*淫夢潜テスト/s);
    assert.ok(await pg.evaluate(() => document.querySelector('#rankingBar .ranking-cell.me') !== null), '自分のセルが強調される');
    assert.ok(Number(await pg.textContent('#scoreText')) >= 4300, '前回の点数から再開');
  });
  await t('リロードしてもログインが保持される / アカウント削除でランキングから消える', async () => {
    await pg.reload(); await pg.evaluate(() => window.__hant8Ready);
    await pg.waitForSelector('#readyView:not([hidden])', { timeout: 10000 });
    assert.match(await pg.textContent('#whoBox'), /淫夢潜テスト/);
    await pg.click('#readySettings'); await pg.waitForSelector('#settingsPanel.open');
    await pg.fill('#deletePw', 'password-1234'); pg.once('dialog', (d) => d.accept()); await pg.click('#deleteButton');
    await pg.waitForSelector('#authMsg.show.ok', { timeout: 10000 });
    assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM accounts WHERE name_key='淫夢潜テスト'").get().c, 0);
  });
  await A.ctx.close();

  // ====== 4. ゲスト / サーバー未設定 ======
  await t('サーバー未設定ならゲスト専用で動く（アカウント系タブは無効）', async () => {
    const G = await newPage({ width: 1280, height: 720 }, { api: false });
    assert.ok(await G.page.isDisabled('#tabLogin')); assert.ok(await G.page.isVisible('#guestButton'));
    await G.page.click('#guestButton'); await G.page.click('#startButton');
    await G.page.waitForSelector('#startupOverlay', { state: 'hidden', timeout: 15000 });
    assert.match(await G.page.textContent('#connectionStatus'), /未設定/);
    await G.ctx.close();
  });


  // ====== 4b. Firebase版（偽SDK）======
  await t('Firebase版: 登録→プレイ→停止で点数がFirestoreへ→リロードでログイン保持→ログアウト→再ログイン', async () => {
    const F = await newPage({ width: 1280, height: 720 }, { firebase: true });
    const p = F.page;
    await p.click('#tabRegister'); await p.fill('#regName', 'ファイア'); await p.fill('#regPw', 'password-1234');
    await p.click('#formRegister button[type=submit]'); await p.waitForSelector('#readyView:not([hidden])', { timeout: 15000 });
    const raw0 = await p.evaluate(() => localStorage.getItem('__fake_fb'));
    assert.ok(!raw0.includes('password-1234'), '生パスワードがFirebase側に渡っている');
    assert.match(Object.keys(JSON.parse(raw0).users)[0], /^[0-9a-f]{32}@hant-inmu\.example$/);
    await p.click('#startButton'); await p.waitForSelector('#startupOverlay', { state: 'hidden', timeout: 15000 });
    await p.evaluate((lm) => { window.__fakeLm = lm; }, POSE);
    await p.waitForFunction(() => document.getElementById('statusChip').textContent.includes('ポーズ中'), null, { timeout: 8000 });
    await p.waitForTimeout(1800);
    assert.match(await p.textContent('#connectionStatus'), /接続中|更新/);
    await p.evaluate(() => { window.__fakeLm = null; });
    await p.click('#stopButton'); await p.waitForSelector('#startupOverlay', { state: 'visible' });
    await p.waitForFunction(() => { const d = JSON.parse(localStorage.getItem('__fake_fb')); return Object.values(d.docs).some((x) => x.score > 50); }, null, { timeout: 5000 });
    await p.reload(); await p.evaluate(() => window.__hant8Ready);
    await p.waitForSelector('#readyView:not([hidden])', { timeout: 10000 });
    assert.match(await p.textContent('#whoBox'), /ファイア/);
    await p.click('#switchAccount'); await p.waitForSelector('#authView:not([hidden])');
    await p.fill('#loginName', 'ファイア'); await p.fill('#loginPw', 'bad-password'); await p.click('#formLogin button[type=submit]');
    await p.waitForSelector('#authMsg.show.err');
    await p.fill('#loginPw', 'password-1234'); await p.click('#formLogin button[type=submit]');
    await p.waitForSelector('#readyView:not([hidden])', { timeout: 15000 });
    assert.deepEqual(F.external, []); assert.deepEqual(F.errors.filter((e) => !/Failed to load resource/.test(e)), []);
    await F.ctx.close();
  });

  // ====== 5. レイアウト（スマホ横画面ほか） ======
  const sizes = [
    ['landscape-iphone-844x390', 844, 390], ['landscape-se-667x375', 667, 375], ['landscape-iphone-max-932x430', 932, 430],
    ['landscape-android-915x412', 915, 412], ['landscape-small-568x320', 568, 320], ['tablet-1024x768', 1024, 768], ['portrait-390x844', 390, 844],
  ];
  for (const [name, w, h] of sizes) {
    await t(`レイアウト ${name}: 起動画面とプレイ画面がはみ出さず操作できる`, async () => {
      const P = await newPage({ width: w, height: h }, { query: '?fast' });
      const landscape = w > h;
      // 起動画面: カードがスクロールで全部届く（ボタンが画面内に到達可能）
      await shot(P.page, `10-${name}-start`);
      await P.page.click('#tabRegister');
      const regBtn = P.page.locator('#formRegister button[type=submit]'); await regBtn.scrollIntoViewIfNeeded(); assert.ok(await regBtn.isVisible());
      await shot(P.page, `11-${name}-register`);
      await P.page.fill('#regName', 'レイアウト' + name.slice(-3)); await P.page.fill('#regPw', 'password-1234');
      await regBtn.click(); await P.page.waitForSelector('#readyView:not([hidden])', { timeout: 15000 });
      const sb = P.page.locator('#startButton'); await sb.scrollIntoViewIfNeeded(); await sb.click();
      await P.page.waitForSelector('#startupOverlay', { state: 'hidden', timeout: 15000 });
      await P.page.evaluate((lm) => { window.__fakeLm = lm; }, POSE);
      await P.page.waitForFunction(() => Number(document.getElementById('ytIcon').style.opacity) > 0.35, null, { timeout: 20000 });
      const m = await noOverflow(P.page, name);
      if (landscape) assert.ok(m.sh <= m.ih + 2, `${name}: 縦にはみ出し ${m.sh}>${m.ih}`);
      // 主要要素が画面内に収まっている
      const boxes = await P.page.evaluate(() => ['.topbar', '.announcement', '.ranking-area', '.route-box', '.camera-preview', '#ytIcon', '.settings-button'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; }));
      for (const [s, l, tp, r, b] of boxes) assert.ok(l >= -1 && r <= w + 1, `${name} ${s} が横にはみ出し: ${l}-${r}/${w}`);
      if (landscape) for (const [s, , tp, , b] of boxes) assert.ok(tp >= -1 && b <= h + 1, `${name} ${s} が縦にはみ出し: ${tp}-${b}/${h}`);
      // カメラ枠とアイコン・ランキングが重ならない/設定ボタンが押せる
      await shot(P.page, `12-${name}-play`);
      await P.page.click('.settings-button'); await P.page.waitForSelector('#settingsPanel.open'); await P.page.waitForTimeout(400); await shot(P.page, `13-${name}-settings`);
      await P.ctx.close();
    });
  }
  console.log(`\n${n} e2e checks passed`);
} finally { await browser.close(); server.close(); }
