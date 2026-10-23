// 手元確認用の簡易サーバー（依存なし）。http://localhost:8080/ で開く。カメラは localhost なら許可される。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8080;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json' };
createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = normalize(join(root, p)); if (!f.startsWith(root) || /node_modules|[\\/]\.|[\\/](worker|tests|scripts)[\\/]/.test(f.slice(root.length))) { res.writeHead(403).end('forbidden'); return; }
    await stat(f); res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(await readFile(f));
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/ を開いてください（止めるには Ctrl+C）`));
