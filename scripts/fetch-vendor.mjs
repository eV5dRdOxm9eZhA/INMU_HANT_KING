// 判定エンジン(MediaPipe)と骨格モデルを vendor/ に取り込む。
// 外部CDNに接続せず自サイトから配信するため（訪問者のIPがCDN/Googleに渡らない）。
// 事前に `npm install` を実行しておくこと。
import { cpSync, mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules/@mediapipe/tasks-vision');
if (!existsSync(join(pkg, 'vision_bundle.mjs'))) { console.error('node_modules に @mediapipe/tasks-vision がありません。先に `npm install` を実行してください。'); process.exit(1); }

const out = join(root, 'vendor/mediapipe');
mkdirSync(out, { recursive: true });
cpSync(join(pkg, 'vision_bundle.mjs'), join(out, 'vision_bundle.mjs'));
cpSync(join(pkg, 'wasm'), join(out, 'wasm'), { recursive: true });

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const modelDir = join(root, 'vendor/models'); mkdirSync(modelDir, { recursive: true });
const modelPath = join(modelDir, 'pose_landmarker_full.task');
if (!existsSync(modelPath) || statSync(modelPath).size < 1_000_000) {
  console.log('モデルをダウンロード中…'); const res = await fetch(MODEL_URL);
  if (!res.ok) { console.error(`モデルの取得に失敗しました: HTTP ${res.status}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) { console.error('モデルのサイズが小さすぎます。取得に失敗した可能性があります。'); process.exit(1); }
  writeFileSync(modelPath, buf);
}
console.log('vendor/ の準備が完了しました。');
