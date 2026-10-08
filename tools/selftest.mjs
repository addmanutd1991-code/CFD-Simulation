/*
 * selftest.mjs — ทดสอบ solver แบบไม่ใช้เบราว์เซอร์: สมดุลพลังงาน การลู่เข้า และเวลาที่ใช้
 *
 *   node tools/selftest.mjs <preset> <cell> <tEnd>            ใช้ WebAssembly (ปกติ)
 *   node tools/selftest.mjs <preset> <cell> <tEnd> --js       บังคับใช้ JavaScript ล้วน
 *   node tools/selftest.mjs <preset> <cell> <tEnd> --compare  เดินทั้งสองแบบคู่กัน ตรวจว่าผลตรงกันทุกบิต
 */
import { presetScene } from '../src/scene.js';
import { buildMesh } from '../src/mesher.js';
import { Solver } from '../src/solver.js';

const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const [key = 'rooftop', cellArg = 0.5, tArg = 1800] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const cell = Number(cellArg), tMax = Number(tArg);
const s = presetScene(key);
s.sim.cell = cell;
const t0 = performance.now();
const mesh = buildMesh(s);
console.log(`preset=${key} cell=${cell} grid=${mesh.nx}x${mesh.ny}x${mesh.nz} (${mesh.nx * mesh.ny * mesh.nz} cells) mesh ${(performance.now() - t0).toFixed(0)} ms`);
mesh.warnings.forEach(w => console.log('  warn:', w));
const params = { ambient: s.site.ambient, windSpeed: s.site.windSpeed, windDir: s.site.windDir, perf: s.perf, tMax };

if (flags.includes('--compare')) {
  const a = new Solver(mesh, { ...params, kernels: null }), b = new Solver(mesh, params);
  if (!b.k) { console.log('โหลด WebAssembly ไม่ได้'); process.exit(1); }
  let ta = 0, tb = 0, bad = 0;
  while (a.time < tMax && !a.converged) {
    let t = performance.now(); a.step(); ta += performance.now() - t;
    t = performance.now(); b.step(); tb += performance.now() - t;
    for (const f of ['u', 'v', 'w', 'T', 'C', 'phi']) for (let c = 0; c < a.N; c++) if (!Object.is(a[f][c], b[f][c])) bad++;
    if (bad) { console.log(`ต่างกันที่สเต็ป ${a.steps}: ${bad} ค่า`); process.exit(1); }
  }
  console.log(`ตรงกันทุกบิต ${a.steps} สเต็ป (t=${a.time.toFixed(1)} s) · JS ${(ta / a.steps).toFixed(1)} ms/step · WebAssembly ${(tb / b.steps).toFixed(1)} ms/step (เร็วขึ้น ${(ta / tb).toFixed(2)} เท่า)`);
  process.exit(0);
}

const sol = new Solver(mesh, flags.includes('--js') ? { ...params, kernels: null } : params);
console.log(`kernels: ${sol.k ? 'WebAssembly' : 'JavaScript'}`);
const t1 = performance.now();
let lastPrint = 0;
while (sol.time < tMax && !sol.converged) {
  sol.step();
  if (sol.time - lastPrint >= 10) {
    lastPrint = sol.time;
    const r = sol.report();
    const tin = mesh.units.map(u => {
      const ms = u.modules.map(i => r.modules[i]);
      const q = ms.reduce((a, m) => a + m.q, 0);
      return (ms.reduce((a, m) => a + m.Tin * m.q, 0) / q).toFixed(2);
    });
    console.log(`t=${sol.time.toFixed(1)} steps=${sol.steps} dt=${sol.dt.toFixed(3)} it=${sol.pIters} div=${(sol.divErr * 100).toFixed(2)}% bal=${(r.balance.ratio * 100).toFixed(1)}% vmax=${sol.vmax.toFixed(2)} Tin=[${tin.join(', ')}] drift=${r.drift.toFixed(3)} res(m/u/e)=${['mass', 'mom', 'energy'].map(k => sol.hist.res[k].at(-1)?.toExponential(1)).join('/')} ${((performance.now() - t1) / sol.steps).toFixed(1)} ms/step`);
  }
}
const r = sol.report();
console.log(`done t=${sol.time.toFixed(1)} converged=${sol.converged} wall=${((performance.now() - t1) / 1000).toFixed(1)} s`);
mesh.units.forEach(u => {
  u.modules.forEach(i => {
    const m = r.modules[i];
    console.log(`  ${u.name} ${m.hp}HP Tin=${m.Tin.toFixed(2)} max=${m.TinMax.toFixed(2)} recirc=${(m.Cin * 100).toFixed(1)}% Tdis=${m.Tdis.toFixed(1)} cap=${(m.capF * 100).toFixed(1)}% blocked=${m.blockedPct.toFixed(0)}% fanA=${m.fanAreaGrid.toFixed(2)}/${m.fanAreaReal.toFixed(2)}`);
  });
});
