import assert from 'node:assert/strict';
import { classifyPose, LEVELS, STICKY_BONUS, Stability } from '../js/pose.js';

// ---- 元ファイル(V4)の classifyPose をそのまま写した基準実装 ----
function angleDeg(a,b,c){const bax=a.x-b.x,bay=a.y-b.y,bcx=c.x-b.x,bcy=c.y-b.y;const l1=Math.hypot(bax,bay),l2=Math.hypot(bcx,bcy);if(l1<1e-6||l2<1e-6)return 0;return Math.acos(Math.max(-1,Math.min(1,(bax*bcx+bay*bcy)/(l1*l2))))*180/Math.PI}
function original(lm){
  const visible=l=>!!l&&(l.visibility==null||l.visibility>=0.35);
  const nose=lm[0],lS=lm[11],rS=lm[12],lE=lm[13],rE=lm[14],lW=lm[15],rW=lm[16];
  if(![lS,rS,lE,rE,lW,rW].every(visible))return false;
  const sw=Math.abs(rS.x-lS.x);if(sw<0.05)return false;
  const up=lW.y<=lS.y+0.12&&rW.y<=rS.y+0.12;
  const m=sw*0.02;const elbowOut=lE.x>=lS.x-m&&rE.x<=rS.x+m;
  const span=Math.abs(rE.x-lE.x)>=sw*1.05;
  const mh=sw*2.0;
  const head=(Math.abs(lW.x-nose.x)<=mh&&lW.x<nose.x+sw*0.45)&&(Math.abs(rW.x-nose.x)<=mh&&rW.x>nose.x-sw*0.45);
  const la=angleDeg(lS,lE,lW),ra=angleDeg(rS,rE,rW);
  const bent=la>=45&&la<=155&&ra>=45&&ra<=155;
  const same=lW.x<lE.x+sw*0.45&&rW.x>rE.x-sw*0.45;
  return elbowOut&&span&&up&&same&&(head||bent);
}

// ---- 合成ポーズ（画像座標・非ミラー。人物の左=画像の右=xが大きい）----
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const jit = (a) => (rnd() - 0.5) * 2 * a;
function body({ sw = 0.22, noseX = 0.5, shY = 0.55 } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: 1 }));
  lm[0] = { x: noseX, y: shY - 0.22, visibility: 1 };
  lm[11] = { x: noseX + sw / 2, y: shY, visibility: 1 };  // 左肩（画像右）
  lm[12] = { x: noseX - sw / 2, y: shY, visibility: 1 };  // 右肩
  return lm;
}
function setArm(lm, side, e, w) { // side:+1=左(画像右), -1=右
  const i = side > 0 ? 13 : 14, j = side > 0 ? 15 : 16;
  lm[i] = { x: e.x, y: e.y, visibility: e.v ?? 1 }; lm[j] = { x: w.x, y: w.y, visibility: w.v ?? 1 };
}
// 淫夢ポーズ: 両手を頭の後ろ、肘は大きく外へ。noise倍率で個人差・検出ブレを再現
function inmuPose(noise = 0, o = {}) {
  const sw = o.sw ?? 0.22, nx = .5 + jit(noise * .04), sy = .55;
  const lm = body({ sw, noseX: nx, shY: sy });
  const spread = (o.spread ?? 1.15) * sw + jit(noise * .05); // 肩から外への肘の張り
  const eY = sy - (o.elbowUp ?? 0.10) * (sw / .22) + jit(noise * .04);
  const wY = sy - (o.wristUp ?? 0.20) + jit(noise * .05);
  setArm(lm, +1, { x: nx + sw / 2 + spread * .55 + jit(noise * .03), y: eY }, { x: nx + .04 + jit(noise * .03), y: wY, v: o.wristVis ?? 1 });
  setArm(lm, -1, { x: nx - sw / 2 - spread * .55 + jit(noise * .03), y: eY }, { x: nx - .04 + jit(noise * .03), y: wY, v: o.wristVis ?? 1 });
  return lm;
}
const armsDown = (n = 0) => { const lm = body(); setArm(lm, +1, { x: .5 + .13 + jit(n * .03), y: .70 }, { x: .5 + .13, y: .84 + jit(n * .03) }); setArm(lm, -1, { x: .5 - .13 + jit(n * .03), y: .70 }, { x: .5 - .13, y: .84 }); return lm; };
const handsOnHips = (n = 0) => { const lm = body(); setArm(lm, +1, { x: .5 + .21 + jit(n * .03), y: .72 }, { x: .5 + .10, y: .84 }); setArm(lm, -1, { x: .5 - .21 + jit(n * .03), y: .72 }, { x: .5 - .10, y: .84 }); return lm; };
const waveOneHand = (n = 0) => { const lm = armsDown(n); setArm(lm, +1, { x: .5 + .20, y: .45 }, { x: .5 + .22, y: .30 }); return lm; };
const crossArms = (n = 0) => { const lm = body(); setArm(lm, +1, { x: .5 + .02 + jit(n * .02), y: .68 }, { x: .5 - .10, y: .62 }); setArm(lm, -1, { x: .5 - .02, y: .68 }, { x: .5 + .10, y: .62 }); return lm; };
const rate = (gen, level, N = 400, sticky = 0) => { let ok = 0; for (let i = 0; i < N; i++) if (classifyPose(gen(i), level + sticky).valid) ok++; return ok / N; };

let pass = 0; const t = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

t('strict は元のV4判定と、ランダムな姿勢1万件で完全一致する', () => {
  seed = 99; let diff = 0;
  for (let i = 0; i < 10000; i++) {
    const lm = Array.from({ length: 33 }, () => ({ x: rnd(), y: rnd(), visibility: rnd() }));
    lm[11].x = .6 + jit(.2); lm[12].x = .4 + jit(.2);
    if (classifyPose(lm, LEVELS.strict).valid !== original(lm)) diff++;
  }
  assert.equal(diff, 0);
  seed = 7; diff = 0;
  for (let i = 0; i < 3000; i++) { const lm = inmuPose(1.5); if (classifyPose(lm, 0).valid !== original(lm)) diff++; }
  assert.equal(diff, 0);
});

seed = 1;
// 個人差を再現した集団: 肘の張り・手首の高さ・体格・隠れ具合・検出ブレをランダムに振る
const person = () => inmuPose(0.4 + rnd() * 1.4, {
  sw: 0.13 + rnd() * 0.17, spread: 0.55 + rnd() * 0.75, wristUp: 0.0 + rnd() * 0.25,
  elbowUp: -0.03 + rnd() * 0.17, wristVis: rnd() < 0.35 ? 0.1 + rnd() * 0.25 : 1,
});
const R = {
  strict: rate(person, LEVELS.strict, 3000),
  normal: rate(person, LEVELS.normal, 3000),
  easy: rate(person, LEVELS.easy, 3000),
  easySticky: rate(person, LEVELS.easy, 3000, STICKY_BONUS),
  occludedEasy: rate((i) => inmuPose(1.0, { wristVis: .2 }), LEVELS.easy),
  occludedStrict: rate((i) => inmuPose(1.0, { wristVis: .2 }), LEVELS.strict),
};
console.log('  成立率(様々な体格・癖の人×3000回):', Object.fromEntries(Object.entries(R).map(([k, v]) => [k, (v * 100).toFixed(0) + '%'])));

t('やさしい は 厳しい(元) より成立率が高い', () => {
  assert.ok(R.easy > R.strict + 0.15, `easy ${R.easy} vs strict ${R.strict}`);
  assert.ok(R.easy >= R.normal && R.normal >= R.strict);
  assert.ok(R.easySticky >= R.easy);
  assert.ok(R.easy >= 0.9, `easyの成立率が低い: ${R.easy}`);
});
t('手首が頭の裏で隠れて信頼度が低くても、やさしいなら通る（元は通らない）', () => {
  assert.equal(R.occludedStrict, 0); assert.ok(R.occludedEasy > 0.85);
});
t('誤判定しない: 気をつけ/腰に手/片手を振る/腕組み は やさしい(成立中の粘り込み)でも不成立', () => {
  for (const [name, g] of Object.entries({ armsDown, handsOnHips, waveOneHand, crossArms })) {
    const r = rate(g, LEVELS.easy, 400, STICKY_BONUS);
    assert.ok(r < 0.02, `${name} が誤判定: ${(r * 100).toFixed(1)}%`);
  }
});
const banzai = (k, n = 0) => { const sw = .22, lm = body({ sw }); setArm(lm, +1, { x: .5 + sw / 2 + sw * k + jit(.02), y: .38 + jit(.03) }, { x: .5 + sw / 2 + sw * k * 1.2 + jit(.02), y: .20 + jit(.03) }); setArm(lm, -1, { x: .5 - sw / 2 - sw * k + jit(.02), y: .38 + jit(.03) }, { x: .5 - sw / 2 - sw * k * 1.2 + jit(.02), y: .20 + jit(.03) }); return lm; };
t('万歳（腕を真上に伸ばす）を やさしい でも弾く', () => {
  for (const k of [0, .15, .3]) { const r = rate(() => banzai(k), LEVELS.easy, 500, STICKY_BONUS); assert.ok(r < 0.05, `万歳(開き${k})が誤判定: ${(r * 100).toFixed(1)}%`); }
});
// ひし形: 頭の後ろで左右の手がくっつき、両肘が横に張る（手首は鼻の高さ付近・手首同士が近い）
const diamondPerson = () => {
  const sw = 0.13 + rnd() * 0.17, nx = .5 + jit(.05), sy = .55, nose = sy - 0.22 * (sw / .22);
  const gap = rnd() * 0.8 * sw, off = (0.45 + rnd() * 0.6) * sw, lm = body({ sw, noseX: nx, shY: sy }); lm[0].y = nose;
  const wy = nose + jit(0.35 * sw), ey = nose + (0.1 + rnd() * 0.6) * sw;
  setArm(lm, +1, { x: nx + sw / 2 + off, y: ey }, { x: nx + gap / 2, y: wy, v: rnd() < 0.3 ? 0.15 : 1 });
  setArm(lm, -1, { x: nx - sw / 2 - off, y: ey }, { x: nx - gap / 2, y: wy, v: rnd() < 0.3 ? 0.15 : 1 });
  return lm;
};
t('ひし形（頭の後ろで手がくっつき、肘が横に張る）は、やさしい で ほぼ成立 / 厳しい(元)では従来どおり', () => {
  seed = 4242; const e = rate(diamondPerson, LEVELS.easy, 2000, STICKY_BONUS), s0 = rate(diamondPerson, LEVELS.easy, 2000);
  assert.ok(e >= 0.93, `ひし形の成立率が低い: ${e}`); assert.ok(s0 >= 0.9, `${s0}`);
  seed = 4242; for (let i = 0; i < 500; i++) { const lm = diamondPerson(); assert.equal(classifyPose(lm, LEVELS.strict).valid, original(lm)); }
});
t('ひし形判定でも、万歳・気をつけ・腰に手・片手・腕組み・両手を胸の前で合わせる は不成立', () => {
  const praying = () => { const lm = body(); setArm(lm, +1, { x: .5 + .08, y: .68 }, { x: .5 + .02, y: .60 }); setArm(lm, -1, { x: .5 - .08, y: .68 }, { x: .5 - .02, y: .60 }); return lm; };
  for (const g of [() => banzai(0), () => banzai(.15), armsDown, handsOnHips, waveOneHand, crossArms, praying]) assert.ok(rate(g, LEVELS.easy, 300, STICKY_BONUS) < 0.03);
});
t('ランドマーク欠損・肩幅ゼロでも例外にならず不成立', () => {
  assert.equal(classifyPose(Array(33).fill(null)).valid, false);
  const lm = body({ sw: 0.01 }); assert.equal(classifyPose(lm).valid, false);
});
t('Stability: 6枚中2枚で成立、全部falseが続けば解除', () => {
  const s = new Stability(); s.push(true); assert.equal(s.stable, false); s.push(true); assert.equal(s.stable, true);
  for (let i = 0; i < 5; i++) s.push(false); assert.equal(s.stable, false);
});
console.log(`\n${pass} tests passed`);
