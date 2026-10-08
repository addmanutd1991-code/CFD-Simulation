/*
 * build-wasm.mjs — คอมไพล์ src/kernels.c เป็น WebAssembly แล้วฝังเป็น base64 ใน src/kernels-wasm.js
 * ต้องมี clang + wasm-ld (LLVM ≥ 15) — ไฟล์ผลลัพธ์ถูก commit ไว้แล้ว จึงต้องรันใหม่เฉพาะเมื่อแก้ kernels.c
 *
 *   npm run build:wasm
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(path.join(tmpdir(), 'cfd-wasm-'));
const out = path.join(dir, 'kernels.wasm');
try {
  execFileSync(process.env.CLANG || 'clang', [
    '--target=wasm32', '-O3', '-ffp-contract=off', '-fno-fast-math', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,--export=__heap_base', '-Wl,--strip-all',
    '-o', out, path.join(root, 'src/kernels.c'),
  ], { stdio: 'inherit' });
  const bytes = await readFile(out);
  const b64 = bytes.toString('base64');
  await writeFile(path.join(root, 'src/kernels-wasm.js'),
    `/* สร้างโดย tools/build-wasm.mjs จาก src/kernels.c — อย่าแก้ด้วยมือ */\nexport const KERNELS_WASM = '${b64}';\n`);
  console.log(`src/kernels-wasm.js  ${bytes.length} bytes wasm`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
