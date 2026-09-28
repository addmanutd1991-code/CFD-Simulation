/*
 * build.mjs — รวมทุกอย่างเป็นไฟล์ HTML ไฟล์เดียว: dist/cdu-airflow-cfd.html
 * ดับเบิลคลิกเปิดได้ทันที ไม่ต้องใช้เว็บเซิร์ฟเวอร์ และไม่ต้องต่ออินเทอร์เน็ต
 * (ยกเว้นฟอนต์ ซึ่งถอยไปใช้ฟอนต์ของเครื่องเมื่อออฟไลน์)
 *
 *   npm install && npm run build
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (...p) => path.join(root, ...p);

// จับคู่ 'three' และ 'three/addons/...' ไปยังสำเนาในโฟลเดอร์ vendor
const vendorThree = {
  name: 'vendor-three',
  setup(b) {
    b.onResolve({ filter: /^three(\/.*)?$/ }, (a) => ({
      path: a.path === 'three' ? r('vendor/three/three.module.js') : r('vendor/three', a.path.slice('three/'.length)),
    }));
  },
};

async function bundle(entry) {
  const res = await build({
    entryPoints: [r(entry)], bundle: true, format: 'iife', minify: true, write: false,
    target: 'es2022', plugins: [vendorThree], logLevel: 'warning',
    supported: { 'import-meta': false },
  });
  return res.outputFiles[0].text;
}

const [workerJs, mainJs, css, html] = await Promise.all([
  bundle('src/worker.js'), bundle('src/main.js'),
  readFile(r('src/app.css'), 'utf8'), readFile(r('index.html'), 'utf8'),
]);

const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
let out = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace('<link rel="stylesheet" href="src/app.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="src/main.js"></script>', () =>
    `<script>globalThis.__CFD_WORKER_SRC__ = ${safe(JSON.stringify(workerJs))};</script>\n<script>${safe(mainJs)}</script>`);

if (out.includes('src/main.js') || out.includes('importmap')) throw new Error('แทนที่ส่วนหัว HTML ไม่สำเร็จ');
await mkdir(r('dist'), { recursive: true });
await writeFile(r('dist/cdu-airflow-cfd.html'), out);
console.log(`dist/cdu-airflow-cfd.html  ${(out.length / 1024).toFixed(0)} KB`);
