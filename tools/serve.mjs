/*
 * serve.mjs — เว็บเซิร์ฟเวอร์ในเครื่องสำหรับเปิดโปรแกรมผ่าน http://localhost (npm run serve [-- พอร์ต])
 *
 * เหตุผล: เบราว์เซอร์ยอมให้หลายเธรดใช้หน่วยความจำร่วมกัน (SharedArrayBuffer) เฉพาะหน้าที่เป็น
 * "cross-origin isolated" คือได้รับส่วนหัว COOP/COEP จากเซิร์ฟเวอร์ — หน้าที่เปิดจากไฟล์ (file://) ไม่มีส่วนหัว
 * เซิร์ฟเวอร์นี้ส่งส่วนหัวทั้งสองให้ทุกไฟล์ และรับเฉพาะการเชื่อมต่อจากเครื่องนี้เอง (127.0.0.1)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) throw Object.assign(new Error('forbidden'), { code: 403 });
    if ((await stat(file)).isDirectory()) { res.writeHead(302, { Location: rel + '/' }); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 403 ? 403 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.code === 403 ? 'forbidden' : 'not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`CDU Airflow CFD  →  http://localhost:${port}/                          (โหมดพัฒนา)`);
  console.log(`                    http://localhost:${port}/dist/cdu-airflow-cfd.html  (ไฟล์รวมชิ้นเดียว)`);
  console.log('กด Ctrl+C เพื่อหยุด');
});
