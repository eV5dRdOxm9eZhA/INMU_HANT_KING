import { classifyPose, Stability, LEVELS, STICKY_BONUS, POSE_TIMING } from './pose.js';
import { createBackend, describeError, ApiError } from './api.js';

/* ============================================================
   HANT_INMU_PLAY_8  公開版
   - カメラ映像の処理(骨格推定)は、すべてこの端末のブラウザ内。映像・座標は外部へ送らない。
   - サーバーへ送るのは「ログイン情報 / 点数」だけ（最終アクセス時刻はサーバー側で記録）。
   - サーバーの種類（Firebase / Cloudflare Workers）は config.js で選ぶ。どちらも js/api.js と同じ形のAPIで扱う。
   ============================================================ */

const $ = (id) => document.getElementById(id);
const FAST = new URLSearchParams(location.search).has('fast'); // 開発用: 動画削除イベントを早く起こす

const CFG = Object.freeze({
  scorePositivePerSecond: 100,
  scoreNegativePerSecond: 10,
  minPoseDetectionConfidence: 0.30,
  minPosePresenceConfidence: 0.30,
  minTrackingConfidence: 0.30,
  // すべて自サイトから配信（外部CDNへ接続しない）
  visionModule: new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href,
  wasmDir: new URL('../vendor/mediapipe/wasm', import.meta.url).href,
  modelUrl: new URL('../vendor/models/pose_landmarker_full.task', import.meta.url).href,
  // 動画削除イベント
  del: Object.freeze({
    warnMs: FAST ? 3000 : 1500, // ?fast はテストしやすいよう長め          // YouTubeアイコンが「うっすら→はっきり」になるまで
    minPoseMs: FAST ? 800 : 7000,        // ポーズを続けて、これだけ経たないとイベントは起きない
    // 次のイベントまでの「ポーズしている時間」。毎回ランダム（間隔が読めないよう、指数分布で短い間隔も長い間隔も出る）
    firstMs: FAST ? [1500, 2500] : [7000, 16000],              // 最初: 一様ランダム
    gapMinMs: FAST ? 4000 : 6000, gapMeanExtraMs: FAST ? 1000 : 9000, gapMaxMs: FAST ? 6000 : 36000,   // 以降: 最短 + 指数分布(平均 +9秒)、上限あり
    afterMs: 1000,         // イベント(回避/削除)が終わってから、この間は「ポーズ中」扱い。ここまでに構え直さないとポーズ切れ
    avoidGraceMs: 300,                   // ポーズをやめて、これだけ経てば「回避成功」
    penalty: 114514,
    bannerMs: 3200,
  }),
});
// 曲の再生位置に合わせて背景が切り替わる（SCENE_SEC秒に1枚、順番に）。枚数は自由で、足りなければ先頭から繰り返す。差し替え・追加はこの配列だけ。
const SCENE_SEC = 10;
const SCENES = ['assets/bg-after.webp', 'assets/scene1.webp', 'assets/scene2.webp', 'assets/scene3.webp', 'assets/scene4.webp', 'assets/scene5.webp'];
const ASSET = { before: 'assets/bg-before.webp', after: SCENES[0], safe: 'assets/safe-cat.svg', sound: 'assets/detect.mp3' };
const BONUS_MULTIPLIER = 2; // 曲を最後まで流しきったときの倍率（その回の獲得点が2倍＝獲得分をもう1回加算）

/* ---------- 端末内の保存（ログイン保持・設定のみ） ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境でも動く */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
};

/* ---------- 要素 ---------- */
const overlay = $('startupOverlay'), startButton = $('startButton'), stopButton = $('stopButton'), settingsStopButton = $('settingsStopButton');
const toggleDebug = $('toggleDebug'), debugSettingsButton = $('debugSettingsButton'), muteButton = $('muteButton'), muteToggle = $('muteToggle');
const safetyToggle = $('safetyToggle'), levelSelect = $('levelSelect'), rankingRefreshButton = $('rankingRefreshButton');
const startupStatus = $('startupStatus'), errorBox = $('errorBox'), connectionStatus = $('connectionStatus');
const backgroundImage = $('backgroundImage'), statusChip = $('statusChip'), stateText = $('stateText'), poseText = $('poseText');
const confidenceText = $('confidenceText'), debugText = $('debugText'), scoreText = $('scoreText'), scoreChip = $('scoreChip');
const camera = $('camera'), poseCanvas = $('poseCanvas'), poseCtx = poseCanvas.getContext('2d'), music = $('music'), rankingBar = $('rankingBar');
const ytIcon = $('ytIcon'), eventBanner = $('eventBanner'), eventPenalty = $('eventPenalty'), toastEl = $('toast'), screenEl = $('screen');
const authView = $('authView'), readyView = $('readyView'), authMsg = $('authMsg'), whoBox = $('whoBox');

/* ---------- 状態 ---------- */
let api = null;                // バックエンド（init()で選ぶ）。送信間隔などは api.limits で決まる
let account = null;            // {id,name,score} / ゲストはnull
let poseLandmarker = null, stream = null, audioCtx = null;
let running = false, systemOn = false, stableValid = false;
let onSince = 0, offSince = 0, lastVideoTime = -1, rafId = 0, debugVisible = false;
let score = 0, lastScoreTime = 0, lastSubmitTime = 0, lastSubmittedScore = null, lastRankingTime = 0;
let submitBusy = false, rankingBusy = false, authLostNotified = false;
const stability = new Stability(POSE_TIMING.stableWindow, POSE_TIMING.stableRequired);
let safetyMode = store.get('hant8_safety') === '1';
let muted = store.get('hant8_muted') === '1';
let level = ['strict', 'normal', 'easy'].includes(store.get('hant8_level')) ? store.get('hant8_level') : 'easy';

const evt = { phase: 'idle', nextInMs: 0, elapsedMs: 0, notPoseMs: 0, poseRunMs: 0, forceMs: 0 };
let runStartScore = 0, pendingBonus = false, sceneIndex = -1;
const rand = ([a, b]) => a + Math.random() * (b - a);
const nextGap = () => Math.min(CFG.del.gapMaxMs, CFG.del.gapMinMs - Math.log(1 - Math.random()) * CFG.del.gapMeanExtraMs);

/* ---------- 表示ヘルパー ---------- */
const showError = (m) => { errorBox.textContent = m; errorBox.classList.add('show'); };
const clearError = () => { errorBox.textContent = ''; errorBox.classList.remove('show'); };
const setConnection = (t) => { connectionStatus.textContent = `ランキング: ${t}`; };
function showAuthMsg(text, kind = 'err') { authMsg.textContent = text; authMsg.className = `auth-msg show ${kind}`; }
function clearAuthMsg() { authMsg.textContent = ''; authMsg.className = 'auth-msg'; }
let toastTimer = 0;
function showToast(text, ms = 2600) {
  toastEl.textContent = text; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function showScore() { scoreText.textContent = String(Math.round(score)); }

/* ---------- 背景 ---------- */
const preloaded = [];
function preloadImages() { for (const u of [ASSET.before, ASSET.safe, ...SCENES]) { const i = new Image(); i.src = u; preloaded.push(i); } }
// 背景は2枚重ねてクロスフェード。下の層に次の画像を入れてから、上の層を透明にする。
const bgFront = backgroundImage, bgBack = bgFront.cloneNode(false);
bgBack.removeAttribute('id'); bgBack.style.opacity = '0'; bgFront.parentNode.insertBefore(bgBack, bgFront.nextSibling);
bgFront.style.transition = bgBack.style.transition = 'opacity .9s ease';
let bgShown = '';
function setBackground(url, instant = true) {
  if (url === bgShown) return; bgShown = url;
  const img = url ? `url("${url}")` : '';
  if (instant) { bgFront.style.transition = bgBack.style.transition = 'none'; bgFront.style.backgroundImage = img; bgBack.style.opacity = '0'; void bgFront.offsetWidth; bgFront.style.transition = bgBack.style.transition = 'opacity .9s ease'; return; }
  bgBack.style.backgroundImage = img; bgBack.style.opacity = '1';
  setTimeout(() => { if (bgShown !== url) return; bgFront.style.transition = 'none'; bgFront.style.backgroundImage = img; bgBack.style.opacity = '0'; void bgFront.offsetWidth; bgFront.style.transition = 'opacity .9s ease'; }, 950);
}
function sceneUrl() {
  sceneIndex = Math.floor(Math.max(0, music.currentTime) / SCENE_SEC) % SCENES.length; // SCENE_SEC秒ごとに次の画像。最後まで行ったら先頭に戻る
  return SCENES[sceneIndex];
}
function currentImageUrl() { if (!systemOn) return ASSET.before; return safetyMode ? ASSET.safe : sceneUrl(); }
function updateScene() { if (systemOn && !safetyMode) { const u = sceneUrl(); if (u !== bgShown) setBackground(u, false); } }

function applyDisplayState() {
  setBackground(currentImageUrl(), !systemOn || safetyMode);
  if (!running) { statusChip.className = 'status-chip'; statusChip.textContent = '未起動 / WAIT'; stateText.textContent = '発見前'; return; }
  if (evt.phase === 'warn') { statusChip.className = 'status-chip warn'; statusChip.textContent = '削除警告!! / WARN'; stateText.textContent = '削除警告'; return; }
  if (systemOn) {
    statusChip.className = 'status-chip on';
    statusChip.textContent = safetyMode ? 'ポーズ中 / 安全' : 'ポーズ中 / ON';
    stateText.textContent = safetyMode ? '安全画像' : '発見後';
  } else {
    statusChip.className = 'status-chip'; statusChip.textContent = '未検出 / WAIT'; stateText.textContent = '発見前';
  }
}

/* ---------- 音 ---------- */
// 曲は最後まで流しきるとボーナス。ミュート中も（無音で）再生を進める＝背景の切替と完走判定が同じように動く。
music.loop = false; music.muted = muted; music.volume = 1.0;
function startSong() { music.currentTime = 0; sceneIndex = -1; runStartScore = score; const p = music.play(); if (p) p.catch(() => {}); }
function setSystemState(on) {
  if (on === systemOn) { applyDisplayState(); return; }
  systemOn = on;
  if (on) startSong(); else { music.pause(); music.currentTime = 0; evt.poseRunMs = 0; }
  applyDisplayState();
}
function songCompleted() {
  if (!running || !systemOn) return;
  const gained = Math.round(score - runStartScore);
  if (gained > 0) {
    const bonus = gained * (BONUS_MULTIPLIER - 1);
    score += bonus; pendingBonus = true; showScore();
    showToast(`🎉 完走ボーナス！ この回の獲得点が${BONUS_MULTIPLIER}倍（+${bonus}）`, 5000);
    scoreChip.classList.add('bonus'); setTimeout(() => scoreChip.classList.remove('bonus'), 2500);
    submitScore(true);
  } else showToast('完走！（この回の獲得点がマイナスのためボーナスなし）', 4000);
  startSong(); // 続けてポーズしていれば、次の回へ
}
music.addEventListener('ended', songCompleted);
function playStrikeSound() {
  if (muted || !audioCtx) return;
  try {
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    // 短い警報音: 高低2音を2回（約0.5秒）
    o.type = 'square';
    [880, 660, 880, 660].forEach((f, i) => o.frequency.setValueAtTime(f, t + i * 0.12));
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.01); g.gain.setValueAtTime(0.16, t + 0.46); g.gain.linearRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.52);
  } catch { /* 音が出なくても進行に影響しない */ }
}

/* ---------- ポーズ判定（端末内） ---------- */
const poseLevel = () => LEVELS[level] + (systemOn ? STICKY_BONUS : 0); // 成立中は少し甘く（粘り）

function resizeCanvas() {
  if (!camera.videoWidth || !camera.videoHeight) return;
  if (poseCanvas.width !== camera.videoWidth || poseCanvas.height !== camera.videoHeight) { poseCanvas.width = camera.videoWidth; poseCanvas.height = camera.videoHeight; }
}
function drawSkeleton(lm, result) {
  poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height); if (!lm || !debugVisible) return;
  const W = poseCanvas.width, H = poseCanvas.height, connections = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [7, 11], [8, 12]];
  poseCtx.lineWidth = Math.max(2, W / 260); poseCtx.strokeStyle = result?.valid ? '#20d675' : '#ffd23e'; poseCtx.fillStyle = '#fff';
  for (const [a, b] of connections) { const p = lm[a], q = lm[b]; if (!p || !q) continue; poseCtx.beginPath(); poseCtx.moveTo(p.x * W, p.y * H); poseCtx.lineTo(q.x * W, q.y * H); poseCtx.stroke(); }
  for (const i of [7, 8, 11, 12, 13, 14, 15, 16]) { const p = lm[i]; if (!p) continue; poseCtx.beginPath(); poseCtx.arc(p.x * W, p.y * H, Math.max(3, W / 85), 0, Math.PI * 2); poseCtx.fill(); }
}
function updateDebug(result, st) {
  if (!result) { confidenceText.textContent = `NO POSE ${st.count}/${POSE_TIMING.stableRequired}`; debugText.textContent = `ポーズ未検出 / 安定判定 ${st.count}/${POSE_TIMING.stableRequired}`; return; }
  confidenceText.textContent = `SCORE ${result.score}/5 / STABLE ${st.count}/${POSE_TIMING.stableRequired}`;
  const ok = (v) => (v ? 'OK' : 'NG');
  debugText.innerHTML = '';
  const parts = [['UP', result.up], ['ELBOW', result.elbowOut], ['HEAD', result.head], ['BENT', result.bent], ['SPAN', result.span]];
  parts.forEach(([k, v], i) => { debugText.append(`${i ? ' / ' : ''}${k}=`); const b = document.createElement('strong'); b.textContent = ok(v); debugText.append(b); });
  debugText.append(` / ${result.reason}`);
}
// 削除イベント中（アイコン表示中）と終了後1秒は、実際にやめていても「ポーズ中」扱い。点数加算と曲の再生が途切れないようにするためで、回避判定には使わない。
const poseOn = () => stableValid || evt.phase === 'warn' || evt.forceMs > 0;
function updateState(now) {
  const valid = poseOn();
  poseText.textContent = valid ? 'TRUE' : 'FALSE';
  if (!systemOn) {
    offSince = 0;
    if (valid) { if (!onSince) onSince = now; if (now - onSince >= POSE_TIMING.onDelayMs) { onSince = 0; setSystemState(true); } } else onSince = 0;
  } else {
    onSince = 0;
    if (!valid) { if (!offSince) offSince = now; if (now - offSince >= POSE_TIMING.offDelayMs) { offSince = 0; setSystemState(false); } } else offSince = 0;
  }
}

/* ---------- 動画削除イベント ---------- */
// ポーズ中に時々 YouTube風アイコンが うっすら出て、だんだんはっきりする。
// 完全にはっきりした瞬間にまだポーズしていたら -114514点。途中でポーズをやめれば削除回避成功（アイコンも消える）。
function setIconProgress(p) {
  ytIcon.classList.remove('fade');
  ytIcon.style.opacity = String(p <= 0 ? 0 : 0.04 + 0.96 * Math.pow(p, 1.7));
  ytIcon.style.transform = `translate(-50%,-50%) scale(${0.85 + 0.15 * p})`;
}
function hideIcon(animated) {
  if (animated) ytIcon.classList.add('fade'); else ytIcon.classList.remove('fade');
  ytIcon.style.opacity = '0'; ytIcon.style.transform = 'translate(-50%,-50%) scale(.85)';
}
function resetEvent(first) { evt.phase = 'idle'; evt.elapsedMs = 0; evt.notPoseMs = 0; evt.nextInMs = first ? rand(CFG.del.firstMs) : nextGap(); if (first) { evt.poseRunMs = 0; evt.forceMs = 0; } hideIcon(false); }
function startWarning() { evt.phase = 'warn'; evt.elapsedMs = 0; evt.notPoseMs = 0; evt.forceMs = 0; setIconProgress(0.02); applyDisplayState(); }
function avoidDeletion() {
  hideIcon(true); resetEvent(false); evt.forceMs = CFG.del.afterMs; applyDisplayState();
  showToast('✔ 削除回避成功！ もう一度ポーズをしてください！', CFG.del.afterMs + 600);
}
function strikeDeletion() {
  score -= CFG.del.penalty; showScore();
  hideIcon(false); resetEvent(false); evt.forceMs = CFG.del.afterMs;
  eventPenalty.textContent = `-${CFG.del.penalty}`;
  eventBanner.classList.add('show'); screenEl.classList.remove('shake'); void screenEl.offsetWidth; screenEl.classList.add('shake');
  scoreChip.classList.add('penalty'); playStrikeSound(); applyDisplayState();
  setTimeout(() => { eventBanner.classList.remove('show'); screenEl.classList.remove('shake'); scoreChip.classList.remove('penalty'); }, CFG.del.bannerMs);
  submitScore(true);
}
function tickEvent(dtMs) {
  if (evt.forceMs > 0) {
    evt.forceMs = Math.max(0, evt.forceMs - dtMs);
    // 終了後の猶予1秒が尽きても構え直していなければ、ポーズ切れ（曲は最初に戻る）
    if (evt.forceMs === 0 && !stableValid && systemOn) { setSystemState(false); showToast('ポーズが途切れました。もう一度ポーズをしてください', 2500); return; }
  }
  if (evt.phase === 'idle') {
    // 起きる条件: ポーズ成立中(systemOn) かつ 今ポーズしている かつ ポーズを続けて minPoseMs 以上
    if (systemOn) {
      evt.poseRunMs += dtMs; evt.nextInMs -= dtMs;
      if (evt.nextInMs <= 0 && evt.poseRunMs >= CFG.del.minPoseMs && stableValid) startWarning();
    } else evt.poseRunMs = 0;
    return;
  }
  // warn: 経過はフレーム間隔の積算（タブが非表示の間に一気に進まない）
  evt.elapsedMs += dtMs;
  if (!stableValid) evt.notPoseMs += dtMs; else evt.notPoseMs = 0; // 回避は実際のポーズで判定
  if (evt.notPoseMs >= CFG.del.avoidGraceMs) { avoidDeletion(); return; }
  const p = Math.min(1, evt.elapsedMs / CFG.del.warnMs);
  setIconProgress(p);
  if (p >= 1) strikeDeletion();
}

/* ---------- 点数・サーバー ---------- */
function tickScore(now) {
  if (!running) return;
  if (!lastScoreTime) { lastScoreTime = now; return; }
  const dt = Math.min(0.25, (now - lastScoreTime) / 1000); lastScoreTime = now;
  if (systemOn) score += CFG.scorePositivePerSecond * dt;
  else if (score > 0) score = Math.max(0, score - CFG.scoreNegativePerSecond * dt);
  showScore();
  tickEvent(dt * 1000); updateScene();
  if (account && now - lastSubmitTime >= api.limits.submitMs) { lastSubmitTime = now; submitScore(false); }
  if (api?.enabled && !document.hidden && now - lastRankingTime >= api.limits.rankingPollMs) { lastRankingTime = now; fetchRanking(); }
}

async function submitScore(force, keepalive = false) {
  if (!account || !api?.enabled) return;
  if (submitBusy && !force) return;
  const value = Math.round(score);
  if (!force && value === lastSubmittedScore) return;
  submitBusy = true;
  try {
    const bonus = pendingBonus; const r = await api.score(value, { keepalive, bonus }); if (bonus) pendingBonus = false;
    lastSubmittedScore = r.score; account.score = r.score;
    if (r.clamped) { score = r.score; showScore(); } // サーバー側の加点速度上限に合わせる
    setConnection(r.rank ? `あなたは ${r.rank}位 / ${new Date().toLocaleTimeString()} 更新` : `${new Date().toLocaleTimeString()} 更新`);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') { handleAuthLost(); }
    else setConnection('通信待機');
  } finally { submitBusy = false; }
}
function handleAuthLost() {
  if (authLostNotified) return; authLostNotified = true;
  clearSession(); setConnection('ログイン切れ（ゲスト扱い）'); showToast('ログインの有効期限が切れました。ゲストとして続行します', 4000);
}

function renderRanking(rows) {
  rankingBar.textContent = '';
  const list = Array.isArray(rows) ? rows.slice(0, 10) : [];
  for (let i = 0; i < 10; i++) {
    const item = list[i], cell = document.createElement('div');
    cell.className = 'ranking-cell' + (item ? '' : ' empty') + (item && account && item.name === account.name ? ' me' : '');
    const r = document.createElement('div'); r.className = 'rank'; r.textContent = `${i + 1}位`;
    const u = document.createElement('div'); u.className = 'user'; u.textContent = item ? String(item.name) : '---';
    const p = document.createElement('div'); p.className = 'points'; p.textContent = item ? String(item.score) : '---';
    cell.append(r, u, p); rankingBar.appendChild(cell);
  }
}
async function fetchRanking() {
  if (!api?.enabled || rankingBusy) return; rankingBusy = true;
  try { renderRanking(await api.ranking()); setConnection('接続中'); }
  catch (e) { setConnection(e instanceof ApiError && e.code === 'origin_not_allowed' ? 'サーバー設定エラー' : '接続失敗'); }
  finally { rankingBusy = false; }
}

/* ---------- 判定エンジン／カメラ ---------- */
async function createPoseLandmarker() {
  startupStatus.textContent = '判定エンジンを読み込み中…';
  let vision;
  try { vision = await import(CFG.visionModule); }
  catch { throw new Error('判定エンジン(vendor/mediapipe)が見つかりません。README「デプロイ」の手順でビルドしてください。'); }
  const fileset = await vision.FilesetResolver.forVisionTasks(CFG.wasmDir);
  const options = {
    baseOptions: { modelAssetPath: CFG.modelUrl, delegate: 'GPU' }, runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: CFG.minPoseDetectionConfidence, minPosePresenceConfidence: CFG.minPosePresenceConfidence, minTrackingConfidence: CFG.minTrackingConfidence,
  };
  try { poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, options); }
  catch (e) { console.warn('GPU delegate failed; fallback CPU', e); poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, { ...options, baseOptions: { modelAssetPath: CFG.modelUrl, delegate: 'CPU' } }); }
}
async function startCamera() {
  startupStatus.textContent = 'カメラの許可を待っています…（映像は端末内でのみ処理されます）';
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
  camera.srcObject = stream; await camera.play();
}

function frame(now) {
  if (!running) return;
  rafId = requestAnimationFrame(frame); tickScore(now);
  if (!poseLandmarker || camera.readyState < 2) return;
  resizeCanvas(); if (camera.currentTime === lastVideoTime) return; lastVideoTime = camera.currentTime;
  try {
    const result = poseLandmarker.detectForVideo(camera, now); const lm = result?.landmarks?.[0] || null;
    if (!lm) { const st = stability.push(false); stableValid = stability.stable; drawSkeleton(null, null); updateDebug(null, st); updateState(now); return; }
    const c = classifyPose(lm, poseLevel()); const st = stability.push(c.valid); stableValid = stability.stable;
    drawSkeleton(lm, c); updateDebug(c, st); updateState(now);
  } catch (error) { console.error('Pose detection error:', error); }
}

async function startSystem() {
  clearError(); startButton.disabled = true;
  // 音の再生許可はユーザー操作の直後でないと取れないので、最初に済ませる
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.();
    if (!music.getAttribute('src')) music.src = ASSET.sound;
    { const p = music.play(); if (p) p.then(() => { if (!systemOn) { music.pause(); music.currentTime = 0; } }).catch(() => {}); }
  } catch { /* 音なしでも続行 */ }
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではカメラAPIを利用できません。HTTPSで開いてください。');
    preloadImages();
    running = true; systemOn = false; stableValid = false; stability.reset();
    score = account ? account.score : 0; lastSubmittedScore = account ? account.score : null; showScore();
    lastScoreTime = performance.now(); lastSubmitTime = performance.now(); lastRankingTime = 0; authLostNotified = false;
    resetEvent(true);
    applyDisplayState();
    await createPoseLandmarker(); await startCamera();
    overlay.style.display = 'none'; stopButton.disabled = false; settingsStopButton.disabled = false; toggleDebug.disabled = false; muteButton.disabled = false;
    startupStatus.textContent = '起動完了'; applyDisplayState(); setConnection(api?.enabled ? '接続確認中' : 'サーバー未設定'); fetchRanking(); rafId = requestAnimationFrame(frame);
  } catch (error) {
    console.error(error); running = false; resetEvent(true); startupStatus.textContent = '起動失敗'; startButton.disabled = false;
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    music.pause();
    showError(error?.name === 'NotAllowedError' ? 'カメラの使用が許可されませんでした。ブラウザの設定でカメラを許可してください。' : (error?.message || String(error)));
  }
}

function stopSystem() {
  const wasRunning = running;
  running = false; cancelAnimationFrame(rafId);
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  camera.srcObject = null; music.pause(); music.currentTime = 0;
  if (poseLandmarker) { try { poseLandmarker.close(); } catch { /* noop */ } poseLandmarker = null; }
  poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
  onSince = 0; offSince = 0; stability.reset(); stableValid = false; systemOn = false;
  resetEvent(true); eventBanner.classList.remove('show'); toastEl.classList.remove('show');
  if (wasRunning && account) { account.score = Math.round(score); submitScore(true); }
  applyDisplayState(); poseText.textContent = 'FALSE'; confidenceText.textContent = 'READY';
  toggleDebug.disabled = true; muteButton.disabled = true; stopButton.disabled = true; settingsStopButton.disabled = true; startButton.disabled = false;
  startupStatus.textContent = '停止しました'; renderWho(); overlay.style.display = 'grid'; closeSettings();
}

/* ---------- アカウント ---------- */
function renderWho() {
  whoBox.textContent = '';
  if (account) {
    whoBox.append('ログイン中: '); const b = document.createElement('b'); b.textContent = account.name; whoBox.append(b, document.createElement('br'), `現在の点数 `);
    const s = document.createElement('b'); s.textContent = String(account.score); whoBox.append(s, ' 点');
  } else {
    whoBox.append('ゲストで参加中', document.createElement('br'), '（点数はランキングに載りません）');
  }
  updateAccountUI();
}
function updateAccountUI() {
  const box = $('settingsAccount');
  box.textContent = account ? `ユーザー名: ${account.name}\nアカウントID: ${account.id}` : 'ゲスト（ランキング非参加）';
  box.style.whiteSpace = 'pre-line';
  $('logoutButton').hidden = !account; $('deleteZone').hidden = !account;
}
function setAccount(acc) {
  account = { id: acc.id, name: acc.name, score: acc.score };
  store.set('hant8_name', acc.name); // ログイン画面の入力補助のみ（ログイン状態自体はバックエンドが保持）
}
function clearSession() { account = null; renderWho(); }
function showReady() { authView.hidden = true; readyView.hidden = false; renderWho(); clearAuthMsg(); startupStatus.textContent = '準備完了。「システム起動」を押すとカメラが起動します'; }
function showAuth(tab = 'login') { authView.hidden = false; readyView.hidden = true; selectTab(tab); startupStatus.textContent = '待機中'; }

function selectTab(name) {
  clearAuthMsg();
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

async function runAuth(form, task) {
  const btn = form.querySelector('button[type=submit]'), label = btn.textContent;
  btn.disabled = true; btn.textContent = '処理中…'; clearAuthMsg(); authLostNotified = false;
  if (!api) { showAuthMsg('準備中です。少し待ってからもう一度お試しください'); btn.disabled = false; btn.textContent = label; return; }
  try { await task(); showReady(); }
  catch (e) { showAuthMsg(describeError(e)); }
  finally { btn.disabled = false; btn.textContent = label; }
}
$('formLogin').addEventListener('submit', (ev) => { ev.preventDefault(); runAuth(ev.target, async () => { const r = await api.login($('loginName').value, $('loginPw').value); setAccount(r.account); $('loginPw').value = ''; }); });
$('formRegister').addEventListener('submit', (ev) => {
  ev.preventDefault();
  runAuth(ev.target, async () => {
    if ($('regPw').value.length < 8) throw new Error('パスワードは8文字以上にしてください');
    const r = await api.register($('regName').value, $('regPw').value); setAccount(r.account); $('regPw').value = '';
  });
});
$('guestButton').addEventListener('click', () => { account = null; showReady(); });
$('randomName').addEventListener('click', () => { $('regName').value = `淫夢潜${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`; });
$('switchAccount').addEventListener('click', async () => { if (account) { try { await api.logout(); } catch { /* 失効済みでもよい */ } } clearSession(); showAuth('login'); });
$('logoutButton').addEventListener('click', async () => { if (running) stopSystem(); try { await api.logout(); } catch { /* noop */ } clearSession(); showAuth('login'); closeSettings(); });
$('deleteButton').addEventListener('click', async () => {
  const pw = $('deletePw').value; if (!account || !pw) { showToast('パスワードを入力してください'); return; }
  if (!confirm(`アカウント「${account.name}」を完全に削除します。点数も消えて元に戻せません。よろしいですか？`)) return;
  try { await api.deleteAccount(account.name, pw); if (running) stopSystem(); clearSession(); $('deletePw').value = ''; showAuth('register'); showAuthMsg('アカウントを削除しました', 'ok'); closeSettings(); }
  catch (e) { showToast(describeError(e), 4000); }
});

/* ---------- 設定パネル ---------- */
const panel = $('settingsPanel'), backdrop = $('drawerBackdrop');
let lastFocus = null;
function openSettings() { lastFocus = document.activeElement; updateAccountUI(); panel.classList.add('open'); backdrop.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); panel.focus(); }
function closeSettings() { panel.classList.remove('open'); backdrop.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* noop */ } } }
$('settingsOpen').addEventListener('click', openSettings); $('readySettings').addEventListener('click', openSettings); $('settingsClose').addEventListener('click', closeSettings); backdrop.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closeSettings(); });

safetyToggle.checked = safetyMode; muteToggle.checked = muted; levelSelect.value = level;
safetyToggle.addEventListener('change', () => { safetyMode = safetyToggle.checked; store.set('hant8_safety', safetyMode ? '1' : '0'); applyDisplayState(); });
levelSelect.addEventListener('change', () => { level = levelSelect.value; store.set('hant8_level', level); });
muteToggle.addEventListener('change', () => {
  muted = muteToggle.checked; store.set('hant8_muted', muted ? '1' : '0'); music.muted = muted; muteButton.textContent = `音声: ${muted ? 'OFF' : 'ON'}`;
});
muteButton.addEventListener('click', () => { muteToggle.checked = !muteToggle.checked; muteToggle.dispatchEvent(new Event('change')); });
toggleDebug.addEventListener('click', () => {
  debugVisible = !debugVisible; toggleDebug.textContent = `判定デバッグ: ${debugVisible ? 'ON' : 'OFF'}`; $('debugPanel').classList.toggle('show', debugVisible);
  if (!debugVisible) poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
});
debugSettingsButton.addEventListener('click', () => toggleDebug.click());
rankingRefreshButton.addEventListener('click', fetchRanking);
startButton.addEventListener('click', startSystem); stopButton.addEventListener('click', stopSystem); settingsStopButton.addEventListener('click', stopSystem);

/* ---------- ページを離れる/隠れるとき: 点数を確定送信 ---------- */
function flush() { if (running && account) { account.score = Math.round(score); submitScore(true, true); } }
window.addEventListener('pagehide', () => { flush(); if (stream) for (const t of stream.getTracks()) t.stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else if (running) { lastRankingTime = 0; } });

/* ---------- 初期化 ---------- */
async function init() {
  setBackground(ASSET.before); renderRanking([]);
  muteButton.textContent = `音声: ${muted ? 'OFF' : 'ON'}`; toggleDebug.textContent = '判定デバッグ: OFF';
  try { api = await createBackend(window.HANT_CONFIG || {}); }
  catch (e) { console.error(e); api = null; }
  if (!api || !api.enabled) {
    for (const id of ['tabLogin', 'tabRegister']) $(id).disabled = true;
    selectTab('guest'); setConnection('サーバー未設定（ゲスト専用）');
    showAuthMsg('ランキングサーバーが未設定のため、ゲストで遊べます。', 'ok'); return;
  }
  startupStatus.textContent = 'ログイン状態を確認中…';
  try { const acc = await Promise.race([api.restore(), new Promise((_, rej) => setTimeout(() => rej(new Error('サーバーに接続できません。ゲストなら遊べます')), 8000))]); if (acc) { setAccount(acc); showReady(); } else { showAuth('login'); const n = store.get('hant8_name'); if (n) $('loginName').value = n; } }
  catch (e) { showAuth('login'); showAuthMsg(describeError(e) + '（ゲストなら遊べます）'); setConnection('接続失敗'); }
  fetchRanking();
}
// 開発用（?fast のときだけ）: テストから内部状態を触れるようにする
if (FAST) window.__hant8 = { evt, CFG, run: () => ({ score, runStartScore, sceneIndex }), markRun: () => { runStartScore = score; } };
window.__hant8Ready = init().catch((e) => console.error(e));
