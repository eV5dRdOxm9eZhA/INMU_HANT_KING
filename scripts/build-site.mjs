// 公開用ファイルだけを _site/ に集める（worker/ tests/ scripts/ README 等は公開しない）。
// 環境変数 API_BASE（Cloudflare Worker のURL）を config.js に書き込む。空ならゲスト専用になる。
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });

for (const need of ['vendor/mediapipe/vision_bundle.mjs', 'vendor/mediapipe/wasm', 'vendor/models/pose_landmarker_full.task', 'vendor/models/pose_landmarker_lite.task']) {
  if (!existsSync(join(root, need))) { console.error(`${need} がありません。先に \`npm run vendor\` を実行してください。`); process.exit(1); }
}
for (const p of ['index.html', 'css', 'js', 'assets', 'vendor']) cpSync(join(root, p), join(out, p), { recursive: true });

// 既定は config.js（Firebase設定）をそのまま公開。API_BASE が設定されていれば Cloudflare Workers 版の設定で上書きする。
let apiBase = (process.env.API_BASE || '').trim();
if (apiBase) {
  let u; try { u = new URL(apiBase); } catch { console.error(`API_BASE がURLではありません: ${apiBase}`); process.exit(1); }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') { console.error('API_BASE は https:// で始めてください。'); process.exit(1); }
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u.origin)) { console.error(`API_BASE のホスト名が不正です: ${u.origin}`); process.exit(1); }
  apiBase = u.origin;
  writeFileSync(join(out, 'config.js'), `window.HANT_CONFIG = ${JSON.stringify({ backend: 'worker', apiBase })};\n`);
} else {
  cpSync(join(root, 'config.js'), join(out, 'config.js'));
}
writeFileSync(join(out, '.nojekyll'), '');
console.log(`_site/ を作成しました（${apiBase ? 'Cloudflare Workers: ' + apiBase : 'config.js の設定（Firebase）'}）`);
