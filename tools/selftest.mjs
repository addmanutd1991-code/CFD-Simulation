/* selftest.mjs — ทดสอบ solver แบบไม่ใช้เบราว์เซอร์: สมดุลพลังงาน การลู่เข้า และเวลาที่ใช้ */
import { presetScene } from '../src/scene.js';
import { buildMesh } from '../src/mesher.js';
import { Solver } from '../src/solver.js';

const key = process.argv[2] || 'rooftop';
const cell = Number(process.argv[3] || 0.5);
const tMax = Number(process.argv[4] || 1800);
const s = presetScene(key);
s.sim.cell = cell;
const t0 = performance.now();
const mesh = buildMesh(s);
console.log(`preset=${key} cell=${cell} grid=${mesh.nx}x${mesh.ny}x${mesh.nz} (${mesh.nx * mesh.ny * mesh.nz} cells) mesh ${(performance.now() - t0).toFixed(0)} ms`);
mesh.warnings.forEach(w => console.log('  warn:', w));
const sol = new Solver(mesh, { ambient: s.site.ambient, windSpeed: s.site.windSpeed, windDir: s.site.windDir, perf: s.perf, tMax });
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
