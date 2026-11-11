/*
 * build-wasm.mjs — คอมไพล์ src/kernels.c เป็น WebAssembly แล้วฝังเป็น base64 ใน src/kernels-wasm.js
 * ต้องมี clang + wasm-ld (LLVM ≥ 15) — ไฟล์ผลลัพธ์ถูก commit ไว้แล้ว จึงต้องรันใหม่เฉพาะเมื่อแก้ kernels.c
 *
 * ได้สองโมดูลจากซอร์สเดียวกัน:
 *   KERNELS_WASM     เธรดเดียว หน่วยความจำปกติ — ใช้ได้ทุกที่
 *   KERNELS_WASM_MT  หลายเธรด (-DTHREADS: shared memory + atomics) — ใช้เมื่อหน้าเว็บเป็น cross-origin isolated
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
const common = [
  '--target=wasm32', '-O3', '-ffp-contract=off', '-fno-fast-math', '-nostdlib', '-mbulk-memory', '-mnontrapping-fptoint',
  '-Wall', '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,--export=__heap_base', '-Wl,--strip-all',
];
const variants = {
  KERNELS_WASM: [],
  KERNELS_WASM_MT: ['-DTHREADS', '-matomics', '-Wl,--shared-memory', '-Wl,--max-memory=4294967296', '-Wl,--export=__stack_pointer'],
};
try {
  let js = '/* สร้างโดย tools/build-wasm.mjs จาก src/kernels.c — อย่าแก้ด้วยมือ */\n';
  for (const [name, flags] of Object.entries(variants)) {
    const out = path.join(dir, name + '.wasm');
    execFileSync(process.env.CLANG || 'clang', [...common, ...flags, '-o', out, path.join(root, 'src/kernels.c')], { stdio: 'inherit' });
    const bytes = await readFile(out);
    js += `export const ${name} = '${bytes.toString('base64')}';\n`;
    console.log(`${name}  ${bytes.length} bytes wasm`);
  }
  await writeFile(path.join(root, 'src/kernels-wasm.js'), js);
} finally {
  await rm(dir, { recursive: true, force: true });
}
