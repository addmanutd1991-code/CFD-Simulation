/*
 * case-thumbs.cjs — ถ่ายภาพแบบจำลองของกรณีศึกษา (PRESETS group 'guide') เป็นภาพย่อ WebP
 * แล้วเขียนเป็น src/case-thumbs.js (data URI) ให้หน้าต่าง "กรณีศึกษา" ใช้ — รันใหม่เมื่อแก้ฉากใน scene.js
 *
 *   npm run serve            (อีกหน้าต่างหนึ่ง — พอร์ต 8000)
 *   node tools/case-thumbs.cjs [http://localhost:8000]
 * ต้องมี Playwright + Chromium
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const url = process.argv[2] || 'http://localhost:8000';
// ระยะซูม (จำนวนรอบล้อเมาส์) ตามเลขกรณี — ฉากเล็กซูมมาก ฉากใหญ่ซูมน้อย
const ZOOM = { 1: 4, 4: 2 };

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1300, height: 900 }, colorScheme: 'light' });
  await p.goto(url + '/index.html');
  await p.waitForSelector('#case-grid [data-preset]', { state: 'attached' });
  await p.waitForTimeout(1500);
  const keys = await p.$$eval('#case-grid [data-preset]', bs => bs.map(x => x.dataset.preset));
  const out = {};
  for (const k of keys) {
    await p.evaluate(key => document.querySelector(`#case-grid [data-preset="${key}"]`).click(), k);
    await p.waitForTimeout(400);
    // ซ่อนระนาบหน้าตัด และทำผนัง/อาคารโปร่งให้เห็นเครื่องด้านใน
    await p.evaluate(() => {
      const s = document.querySelector('#d-section'); if (s.checked) s.click();
      const o = document.querySelector('#d-opacity'); o.value = '0.45'; o.dispatchEvent(new Event('input'));
    });
    const vb = await (await p.$('#viewport canvas')).boundingBox();
    await p.mouse.move(vb.x + vb.width * 0.46, vb.y + vb.height * 0.53);
    const n = ZOOM[k.split('-')[1]] ?? 5;
    for (let i = 0; i < n; i++) { await p.mouse.wheel(0, -120); await p.waitForTimeout(60); }
    await p.waitForTimeout(600);
    out[k] = await p.evaluate(() => {
      const c = document.querySelector('#viewport canvas');
      const W = c.width, H = c.height, cw = W * 0.62, ch = cw * 0.625;
      const o = document.createElement('canvas'); o.width = 360; o.height = 225;
      o.getContext('2d').drawImage(c, Math.max(0, W * 0.46 - cw / 2), Math.max(0, H * 0.53 - ch / 2), cw, ch, 0, 0, 360, 225);
      return o.toDataURL('image/webp', 0.78);
    });
  }
  await b.close();
  const body = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
  const file = path.join(__dirname, '..', 'src', 'case-thumbs.js');
  fs.writeFileSync(file, `// สร้างโดย tools/case-thumbs.cjs — ภาพย่อแบบจำลองของกรณีศึกษา (อย่าแก้ด้วยมือ)\nexport default {\n${body}\n};\n`);
  console.log(`${keys.length} ภาพ → src/case-thumbs.js (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
})();
