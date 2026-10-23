// ポーズ判定（純粋ロジック）。DOM・通信に一切依存しない。映像は端末内でのみ扱う。
//
// 元のV4判定をベースに、しきい値を「厳しい(strict)=元の値」〜「やさしい(easy)」の間で
// 連続的に調整できるようにした。ポーズ成立中はさらに少しだけ甘くする（粘り＝ヒステリシス）。

export const LEVELS = Object.freeze({
  strict: 0,   // 元のV4と同じ
  normal: 0.55,
  easy: 1.0,   // 既定
});
export const STICKY_BONUS = 0.3; // すでに成立中のときに上乗せする甘さ

// [strict値, easy値]。s=0でstrict、s=1でeasy、s>1は更に甘い方向へ外挿する。
const P = {
  vis:        [0.35, 0.12],  // ランドマーク信頼度の下限（手首が頭の裏に隠れても通す）
  upBySw:     [0.00, 1.00],  // 手首が肩より下にあってよい量（肩幅比。strictでは無効＝元の絶対値0.12のみ）
  elbowMargin:[0.02, 0.25],  // 肘が肩より内側にあってよい量（肩幅比）
  spanMin:    [1.05, 0.85],  // 左右の肘の間隔の下限（肩幅比）
  headX:      [2.00, 2.70],  // 手首と鼻の左右距離の上限（肩幅比）
  headSide:   [0.45, 0.80],  // 手首が鼻を越えてよい量（肩幅比）
  bentMin:    [45, 25],      // 肘の曲がり角の下限(度)
  bentMax:    [155, 176],    // 肘の曲がり角の上限(度)
  sameSide:   [0.45, 0.80],  // 手首が肘より内側へ入ってよい量（肩幅比）
  straightMax:[180, 158],    // 腕の伸び（肘角）の上限。万歳＝腕を真上に伸ばす姿勢を弾く（strictでは無効）
  wristTop:   [99, 0.55],    // 手首が鼻より上にあってよい量（肩幅比）。同じく万歳対策（strictでは無効）
};
// 「ひし形」判定（頭の後ろで左右の手がくっつき、両腕で横長のひし形）。元のV4判定とは別の入口で、どちらかが成立すればOK。
// [s=0側, s=1側]。strict(s<=0)では無効＝元のV4と完全に同じ。
const D = {
  wristGap:   [0.60, 1.20],  // 左右の手首の間隔の上限（肩幅比）。「手がくっついている」
  elbowSpan:  [1.20, 0.90],  // 左右の肘の間隔の下限（肩幅比）。「横に広い」
  diamond:    [0.50, 0.20],  // 肘の間隔 − 手首の間隔 の下限（肩幅比）。肘のほうが手より外にある＝ひし形
  wristTop:   [0.70, 1.00],  // 手首が鼻より上にあってよい量（肩幅比）。万歳を弾く
  wristLow:   [0.50, 0.90],  // 手首が鼻より下にあってよい量（肩幅比）
  centerX:    [0.50, 0.90],  // 手首の中点と鼻の左右ずれの上限（肩幅比）
  elbowLow:   [0.90, 1.40],  // 肘が鼻より下にあってよい量（肩幅比）
  elbowTop:   [0.80, 1.10],  // 肘が鼻より上にあってよい量（肩幅比）
  angleMax:   [120, 150],    // 肘の曲がり角の上限(度)。腕がまっすぐ伸びた姿勢を弾く
};
const lerp = (a, b, s) => a + (b - a) * s;
export function thresholds(s) {
  const t = {};
  for (const k of Object.keys(P)) t[k] = lerp(P[k][0], P[k][1], s);
  t.vis = Math.max(0.05, t.vis);
  t.spanMin = Math.max(0.6, t.spanMin);
  t.bentMin = Math.max(10, t.bentMin);
  t.bentMax = Math.min(179, t.bentMax);
  // 万歳対策の2条件は「元の判定にない追加条件」なので、strict(s<=0)では完全に無効にする。
  if (s <= 0) { t.straightMax = 181; t.wristTop = Infinity; }
  else { t.wristTop = Math.max(0.45, lerp(0.90, 0.55, Math.min(s, 1)) - Math.max(0, s - 1) * 0.35); }
  return t;
}

export function diamondThresholds(s) {
  const t = {}; for (const k of Object.keys(D)) t[k] = lerp(D[k][0], D[k][1], s);
  t.angleMax = Math.min(172, t.angleMax); t.wristGap = Math.min(1.6, t.wristGap); t.elbowSpan = Math.max(0.6, t.elbowSpan);
  return t;
}

export const POSE_TIMING = Object.freeze({
  onDelayMs: 150,      // 元350 → 成立までの待ちを短縮（反応を速く）
  offDelayMs: 800,     // 元550 → 一瞬の取りこぼしで途切れない
  stableWindow: 6,
  stableRequired: 2,
});

const fail = (reason) => ({ valid: false, reason, score: 0, up: false, elbowOut: false, head: false, bent: false, span: false });

export function angleDeg(a, b, c) {
  const bax = a.x - b.x, bay = a.y - b.y, bcx = c.x - b.x, bcy = c.y - b.y;
  const l1 = Math.hypot(bax, bay), l2 = Math.hypot(bcx, bcy);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, (bax * bcx + bay * bcy) / (l1 * l2)));
  return Math.acos(cos) * 180 / Math.PI;
}

/**
 * @param landmarks MediaPipe Pose の33点（正規化座標）
 * @param s 甘さ (0=元のV4, 1=やさしい)。成立中は呼び出し側で STICKY_BONUS を足す。
 */
export function classifyPose(landmarks, s = LEVELS.easy) {
  const t = thresholds(s);
  const visible = (lm) => !!lm && (lm.visibility == null || lm.visibility >= t.vis);
  const nose = landmarks[0];
  const lS = landmarks[11], rS = landmarks[12], lE = landmarks[13], rE = landmarks[14], lW = landmarks[15], rW = landmarks[16];
  if (!nose || ![lS, rS, lE, rE, lW, rW].every(visible)) return fail('ランドマーク信頼度不足');

  const sw = Math.abs(rS.x - lS.x);
  if (sw < 0.05) return fail('肩幅が小さすぎます');

  const upLimit = Math.max(0.12, sw * t.upBySw); // 0.12は元V4の絶対値
  const up = lW.y <= lS.y + upLimit && rW.y <= rS.y + upLimit;

  const em = sw * t.elbowMargin;
  const elbowOut = lE.x >= lS.x - em && rE.x <= rS.x + em;

  const span = Math.abs(rE.x - lE.x) >= sw * t.spanMin;

  const maxHeadX = sw * t.headX, hs = sw * t.headSide;
  const head = Math.abs(lW.x - nose.x) <= maxHeadX && lW.x < nose.x + hs
            && Math.abs(rW.x - nose.x) <= maxHeadX && rW.x > nose.x - hs;

  const la = angleDeg(lS, lE, lW), ra = angleDeg(rS, rE, rW);
  const bent = la >= t.bentMin && la <= t.bentMax && ra >= t.bentMin && ra <= t.bentMax;

  const notStraight = la <= t.straightMax && ra <= t.straightMax;
  const wristsLow = lW.y >= nose.y - sw * t.wristTop && rW.y >= nose.y - sw * t.wristTop;

  const ss = sw * t.sameSide;
  const sameSide = lW.x < lE.x + ss && rW.x > rE.x - ss;

  // ひし形判定（左右の向きに依存しない絶対値で比較）
  let diamond = false;
  if (s > 0) {
    const d = diamondThresholds(s);
    const gap = Math.abs(lW.x - rW.x), eSpan = Math.abs(lE.x - rE.x), cx = (lW.x + rW.x) / 2;
    diamond = gap <= sw * d.wristGap
      && eSpan >= sw * d.elbowSpan && eSpan - gap >= sw * d.diamond
      && Math.abs(cx - nose.x) <= sw * d.centerX
      && lW.y >= nose.y - sw * d.wristTop && rW.y >= nose.y - sw * d.wristTop
      && lW.y <= nose.y + sw * d.wristLow && rW.y <= nose.y + sw * d.wristLow
      && lE.y <= nose.y + sw * d.elbowLow && rE.y <= nose.y + sw * d.elbowLow
      && lE.y >= nose.y - sw * d.elbowTop && rE.y >= nose.y - sw * d.elbowTop
      && la <= d.angleMax && ra <= d.angleMax;
  }

  let score = 0; if (up) score++; if (elbowOut) score++; if (head) score++; if (bent) score++; if (span) score++;
  const classic = elbowOut && span && up && sameSide && (head || bent) && notStraight && wristsLow;
  const valid = classic || diamond;

  let reason = diamond && !classic ? '成立（ひし形）' : '成立';
  if (!valid) {
    if (!elbowOut) reason = '肘が外側に開いていません';
    else if (!span) reason = '肘の左右幅不足';
    else if (!up) reason = '手首が十分上にありません';
    else if (!sameSide) reason = '左右の腕位置が不自然です';
    else if (!notStraight) reason = '腕が伸びすぎています（万歳ではなく頭の後ろへ）';
    else if (!wristsLow) reason = '手首が高すぎます（頭の後ろへ）';
    else reason = '頭付近または腕の曲がりを確認できません';
  }
  return { valid, reason, score, up, elbowOut, head, bent, span, sameSide, diamond, shoulderWidth: sw, leftAngle: la, rightAngle: ra };
}

/** 直近N枚のうちM枚成立で「安定して成立」とみなす */
export class Stability {
  constructor(win = POSE_TIMING.stableWindow, need = POSE_TIMING.stableRequired) { this.win = win; this.need = need; this.buf = []; this.stable = false; }
  push(v) {
    this.buf.push(!!v); if (this.buf.length > this.win) this.buf.shift();
    const count = this.buf.reduce((n, x) => n + (x ? 1 : 0), 0);
    this.stable = count >= this.need;
    return { count, total: this.buf.length, stable: this.stable };
  }
  reset() { this.buf = []; this.stable = false; }
}
