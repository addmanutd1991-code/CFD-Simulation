/*
 * main.js — ตัวควบคุมหลักของแอป
 * เชื่อม UI (ริบบอน / โครงสร้างแบบจำลอง / แผงคุณสมบัติ) เข้ากับ solver และ viewer
 */

import { Solver } from './solver.js';
import { Viewer, supplySeeds } from './viewer.js';
import {
  TYPES, createDevice, placeY, buildDomain, updateSupplyTemps,
  autoFlow, BTU_OPTIONS,
} from './devices.js';
import { PRESETS } from './presets.js';

const MAX_CELLS = 600000;

const S = {
  mode: 'indoor',
  room: { W: 5, H: 2.7, D: 4 },
  ambient: 32,
  mesh: 0.15,
  wind: { speed: 0, dirDeg: 0 },
  devices: [],
  selected: null,
  running: false,
  budget: 25,
  field: 'T',
  axis: 'Y',
  slicePos: 0.45,
  showSlice: true,
  showVec: true,
  showPart: true,
  autoRange: true,
  lo: 12, hi: 35,
};

const solver = new Solver();
let viewer = null;
let bound = new Map();
let domainKey = '';
let smoothLo = null, smoothHi = null;

const $ = (id) => document.getElementById(id);

/* ═══════════ การสร้าง / อัปเดตโดเมน ═══════════ */

function domainSignature() {
  return [S.mode, S.room.W, S.room.H, S.room.D, S.mesh].join('|');
}

function estimateCells(W, H, D, h) {
  return (Math.round(W / h) + 2) * (Math.round(H / h) + 2) * (Math.round(D / h) + 2);
}

/** สร้างโดเมนใหม่ทั้งหมด keepResults = true เมื่อเปลี่ยนแค่ตำแหน่งวัตถุ */
function rebuild(keepResults = false) {
  const sig = domainSignature();
  const fresh = sig !== domainKey;

  if (fresh) {
    let h = S.mesh;
    while (estimateCells(S.room.W, S.room.H, S.room.D, h) > MAX_CELLS && h < 0.6) h += 0.05;
    if (Math.abs(h - S.mesh) > 1e-6) {
      setStatus(`โดเมนใหญ่เกินไปสำหรับเมชที่เลือก — ปรับขนาดเซลล์เป็น ${h.toFixed(2)} ม. โดยอัตโนมัติ`);
    }
    solver.ambient = S.ambient;
    solver.resize(S.room.W, S.room.H, S.room.D, h);
    domainKey = sig;
    viewer.setRoom(S.room.W, S.room.H, S.room.D, S.mode === 'outdoor');
    for (const d of S.devices) placeY(d, S.room.H);
  }

  solver.ambient = S.ambient;
  solver.wind = S.wind;
  bound = buildDomain(solver, S.devices, S.mode === 'outdoor');
  if (fresh || !keepResults) solver.reset();

  viewer.syncDevices(S.devices);
  viewer.setSeeds(supplySeeds(S.devices));
  refreshTree();
  refreshMeshInfo();
  updateModeUI();
}

function refreshMeshInfo() {
  const c = solver.nx * solver.ny * solver.nz;
  const txt = `${solver.nx}×${solver.ny}×${solver.nz} = ${c.toLocaleString('th-TH')} เซลล์ (${solver.h.toFixed(2)} ม.)`;
  $('mesh-info').textContent = `เซลล์โดยประมาณ: ${txt}`;
  $('st-mesh').textContent = `เมช: ${txt}`;
}

function updateModeUI() {
  const outdoor = S.mode === 'outdoor';
  $('mode-badge').textContent = outdoor ? 'OUTDOOR' : 'INDOOR';
  $('mode-badge').className = 'badge ' + (outdoor ? 'badge-outdoor' : 'badge-indoor');
  $('room-group-title').textContent = outdoor ? 'ขนาดพื้นที่จำลอง (เมตร)' : 'ขนาดห้อง (เมตร)';
  $('wind-group').style.display = outdoor ? '' : 'none';
  $('btn-mode-indoor').classList.toggle('active', !outdoor);
  $('btn-mode-outdoor').classList.toggle('active', outdoor);
}

function setStatus(msg) { $('st-msg').textContent = msg; }

/* ═══════════ โครงสร้างแบบจำลอง (ต้นไม้ด้านซ้าย) ═══════════ */

function refreshTree() {
  const ul = $('model-tree');
  ul.innerHTML = '';
  const groups = [
    ['เครื่องปรับอากาศ', d => TYPES[d.type].kind === 'ac'],
    ['คอยล์ร้อน', d => TYPES[d.type].kind === 'cdu'],
    ['แหล่งความร้อน', d => TYPES[d.type].kind === 'heat'],
    ['สิ่งกีดขวาง', d => TYPES[d.type].kind === 'solid'],
  ];
  let any = false;
  for (const [title, test] of groups) {
    const items = S.devices.filter(test);
    if (!items.length) continue;
    any = true;
    const head = document.createElement('li');
    head.className = 'tree-head';
    head.textContent = `${title} (${items.length})`;
    ul.appendChild(head);
    for (const d of items) {
      const li = document.createElement('li');
      li.className = d.id === S.selected ? 'sel' : '';
      li.innerHTML = `<span class="tico">${TYPES[d.type].icon}</span>
        <span class="tname">${escapeHtml(d.name)}</span>
        <span class="tdel" title="ลบ">✕</span>`;
      li.onclick = (e) => {
        if (e.target.classList.contains('tdel')) { removeDevice(d.id); return; }
        select(d.id);
      };
      ul.appendChild(li);
    }
  }
  if (!any) {
    const li = document.createElement('li');
    li.className = 'tree-head';
    li.textContent = 'ยังไม่มีวัตถุในแบบจำลอง';
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ═══════════ แผงคุณสมบัติ (ด้านขวา) ═══════════ */

function select(id) {
  S.selected = id;
  viewer.setSelected(id);
  refreshTree();
  refreshProps();
}

function getSelected() { return S.devices.find(d => d.id === S.selected) || null; }

function refreshProps() {
  const body = $('props-body');
  body.innerHTML = '';
  const d = getSelected();
  if (!d) {
    body.innerHTML = '<div class="hint pad">คลิกเลือกวัตถุใน 3D หรือในโครงสร้างแบบจำลอง เพื่อแก้ไขคุณสมบัติ<br><br>💡 ลากวัตถุใน 3D เพื่อย้ายตำแหน่งได้เลย</div>';
    return;
  }
  const def = TYPES[d.type];

  const head = document.createElement('div');
  head.className = 'prop-name';
  head.innerHTML = `<span>${def.icon}</span><span>${escapeHtml(d.name)}</span>`;
  body.appendChild(head);

  sec(body, 'ทั่วไป');
  textRow(body, 'ชื่อ', d.name, v => { d.name = v || def.short; refreshTree(); refreshProps(); });
  if (def.kind === 'ac' || def.kind === 'cdu') {
    checkRow(body, 'เปิดใช้งาน', d.on, v => { d.on = v; apply(); });
  }

  sec(body, 'ตำแหน่ง (เมตร)');
  numRow(body, 'X', d.pos.x, 0, S.room.W, 0.05, v => { d.pos.x = v; apply(true); });
  numRow(body, 'Z', d.pos.z, 0, S.room.D, 0.05, v => { d.pos.z = v; apply(true); });
  if (d.type === 'cassette') {
    note(body, 'คาสเซ็ทติดชิดฝ้าเสมอ — ปรับความสูงได้ที่ขนาดห้อง');
  } else {
    numRow(body, 'ความสูงกึ่งกลาง Y', d.pos.y, 0, S.room.H, 0.05, v => {
      d.mountY = v; placeY(d, S.room.H); apply(true);
    });
  }
  selRow(body, 'หมุน (yaw)', String(d.yaw), [['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']],
    v => { d.yaw = +v; apply(); });

  if (def.resizable) {
    sec(body, 'ขนาด (เมตร)');
    numRow(body, 'กว้าง X', d.size.x, 0.1, 20, 0.05, v => { d.size.x = v; apply(); });
    numRow(body, 'สูง Y', d.size.y, 0.1, 20, 0.05, v => { d.size.y = v; placeY(d, S.room.H); apply(); });
    numRow(body, 'ลึก Z', d.size.z, 0.1, 20, 0.05, v => { d.size.z = v; apply(); });
  }

  if (def.kind === 'ac' || def.kind === 'cdu') {
    sec(body, def.kind === 'cdu' ? 'สมรรถนะคอยล์ร้อน' : 'สมรรถนะเครื่องปรับอากาศ');
    selRow(body, 'ขนาด (BTU/hr)', String(d.btu), BTU_OPTIONS.map(b => [String(b), b.toLocaleString('en-US')]),
      v => { d.btu = +v; d.flow = autoFlow(d.type, d.btu); apply(); refreshProps(); });
    numRow(body, 'อัตราลม (m³/h)', d.flow, 50, 20000, 10, v => { d.flow = v; apply(); });
    if (def.kind === 'ac') {
      selRow(body, 'โหมดคิดลมจ่าย', d.mode, [['auto', 'คำนวณจาก BTU'], ['fixed', 'กำหนดอุณหภูมิเอง']],
        v => { d.mode = v; apply(); refreshProps(); });
      if (d.mode === 'fixed') {
        numRow(body, 'อุณหภูมิลมจ่าย (°C)', d.supplyT, 5, 30, 0.5, v => { d.supplyT = v; apply(true); });
      }
      numRow(body, 'ตั้งอุณหภูมิห้อง (°C)', d.setpoint, 16, 30, 0.5, v => { d.setpoint = v; apply(true); });
    } else {
      selRow(body, 'ทิศทางลมทิ้ง', d.discharge, [['front', 'ออกด้านหน้า'], ['top', 'ออกด้านบน']],
        v => { d.discharge = v; apply(); });
    }
    if (d.vane !== undefined) {
      numRow(body, 'มุมบานเกล็ด (°)', d.vane, 0, 70, 5, v => { d.vane = v; apply(); });
    }

    sec(body, 'ค่าที่วัดได้ขณะคำนวณ');
    const live = document.createElement('div');
    live.id = 'prop-live';
    body.appendChild(live);
  }

  if (def.kind === 'heat') {
    sec(body, 'ภาระความร้อน');
    numRow(body, 'กำลัง (วัตต์)', d.watts, 0, 20000, 10, v => { d.watts = v; apply(); });
    checkRow(body, 'เป็นวัตถุทึบ', !!d.solidBody, v => { d.solidBody = v; apply(); });
    note(body, 'คนนั่งทำงาน ≈ 110 W/คน · คอมพิวเตอร์ตั้งโต๊ะ ≈ 150 W · ไฟ LED ≈ 10 W/ตร.ม.');
  }
}

function refreshLiveProps() {
  const el = $('prop-live');
  if (!el) return;
  const d = getSelected();
  if (!d) return;
  const def = TYPES[d.type];
  const rows = [];
  if (def.kind === 'cdu') {
    const sc = d._scDelta ?? 0;
    rows.push(['อากาศเข้าคอยล์', fmt(d._intakeT, '°C')]);
    rows.push(['ลมทิ้งออก', fmt(d._supplyT, '°C')]);
    rows.push(['วนกลับ (short-circuit)', `<b class="${sc > 3 ? 'stat-bad' : sc > 1.5 ? 'stat-warn' : 'stat-good'}">+${sc.toFixed(1)} K</b>`]);
  } else {
    const sc = d._returnT != null && d._roomT != null ? d._roomT - d._returnT : 0;
    rows.push(['อุณหภูมิห้อง (เทอร์โมสตัท)', fmt(d._roomT, '°C')]);
    rows.push(['อุณหภูมิลมกลับ', fmt(d._returnT, '°C')]);
    rows.push(['อุณหภูมิลมจ่าย', fmt(d._supplyT, '°C')]);
    rows.push(['ลมเย็นวนกลับเข้าเครื่อง', `<b class="${sc > 3 ? 'stat-bad' : sc > 1.5 ? 'stat-warn' : 'stat-good'}">${sc.toFixed(1)} K</b>`]);
    rows.push(['คอมเพรสเซอร์', `<b class="${d.running ? 'stat-good' : 'stat-warn'}">${d.running ? 'ทำงาน' : 'ตัด (ถึงอุณหภูมิ)'}</b>`]);
    rows.push(['ความเย็นที่ให้จริง', d._load ? `<b>${(d._load / 1000).toFixed(2)} kW</b>` : '<b>0.00 kW</b>']);
  }
  el.innerHTML = rows.map(([a, b]) => `<div class="stat-row" style="padding:3px 10px"><span>${a}</span>${b}</div>`).join('');
}

function fmt(v, unit) { return v == null ? '<b>–</b>' : `<b>${v.toFixed(1)} ${unit}</b>`; }

/* ตัวช่วยสร้างแถวในแผงคุณสมบัติ */
function sec(p, t) { const e = document.createElement('div'); e.className = 'prop-sec'; e.textContent = t; p.appendChild(e); }
function note(p, t) { const e = document.createElement('div'); e.className = 'prop-note'; e.textContent = t; p.appendChild(e); }

function mkRow(p, label) {
  const r = document.createElement('div');
  r.className = 'prop-row';
  const l = document.createElement('label');
  l.textContent = label;
  r.appendChild(l);
  p.appendChild(r);
  return r;
}
function numRow(p, label, val, min, max, step, cb) {
  const r = mkRow(p, label);
  const i = document.createElement('input');
  i.type = 'number'; i.min = min; i.max = max; i.step = step;
  i.value = round2(val);
  i.onchange = () => {
    const v = Math.max(min, Math.min(max, parseFloat(i.value) || 0));
    i.value = round2(v); cb(v);
  };
  r.appendChild(i);
}
function textRow(p, label, val, cb) {
  const r = mkRow(p, label);
  const i = document.createElement('input');
  i.type = 'text'; i.value = val; i.style.width = '130px';
  i.onchange = () => cb(i.value.trim());
  r.appendChild(i);
}
function selRow(p, label, val, opts, cb) {
  const r = mkRow(p, label);
  const s = document.createElement('select');
  for (const [v, t] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    s.appendChild(o);
  }
  s.value = val;
  s.onchange = () => cb(s.value);
  r.appendChild(s);
}
function checkRow(p, label, val, cb) {
  const r = mkRow(p, label);
  const i = document.createElement('input');
  i.type = 'checkbox'; i.checked = val;
  i.onchange = () => cb(i.checked);
  r.appendChild(i);
}
function round2(v) { return Math.round(v * 100) / 100; }

/* ═══════════ การจัดการวัตถุ ═══════════ */

function apply(keep = false) {
  rebuild(keep);
}

function addDevice(type) {
  const d = createDevice(type, { x: S.room.W / 2, z: S.room.D / 2 }, S.room.H);
  // วางเครื่องติดผนังชิดกำแพงซ้าย เพื่อให้ใช้งานได้ทันที
  if (type === 'wall') { d.pos.x = d.size.x / 2 + 0.02; d.yaw = 0; }
  if (type === 'outdoor' && S.mode === 'indoor') {
    setStatus('คอยล์ร้อนควรใช้ในโหมด "ภายนอก" — สลับโหมดได้ที่แท็บแบบจำลอง');
  }
  S.devices.push(d);
  rebuild();
  select(d.id);
  setStatus(`เพิ่ม ${d.name} แล้ว — ลากใน 3D เพื่อย้ายตำแหน่ง`);
}

function removeDevice(id) {
  const i = S.devices.findIndex(d => d.id === id);
  if (i < 0) return;
  const name = S.devices[i].name;
  S.devices.splice(i, 1);
  if (S.selected === id) S.selected = null;
  rebuild();
  select(S.selected);
  setStatus(`ลบ ${name} แล้ว`);
}

/* ═══════════ การแสดงผลลัพธ์ ═══════════ */

function updateVisuals(dtReal) {
  const solved = solver.steps > 0;

  if (S.showSlice) {
    const sl = solver.slice(S.axis, S.slicePos, S.field);
    let lo, hi;
    if (S.autoRange) {
      const pad = Math.max(0.3, (sl.max - sl.min) * 0.04);
      lo = sl.min - pad; hi = sl.max + pad;
      if (S.field === 'V') lo = 0;
      if (hi - lo < 0.6) hi = lo + 0.6;
      smoothLo = smoothLo == null ? lo : smoothLo + (lo - smoothLo) * 0.15;
      smoothHi = smoothHi == null ? hi : smoothHi + (hi - smoothHi) * 0.15;
      lo = smoothLo; hi = smoothHi;
      $('res-min').value = round2(lo);
      $('res-max').value = round2(hi);
    } else {
      lo = S.lo; hi = S.hi;
    }
    S.viewLo = lo; S.viewHi = hi;
    viewer.updateSlice(sl, lo, hi);
    updateColorbar(lo, hi);
    const p = S.axis === 'Y' ? sl.pos : sl.pos;
    $('res-pos-label').textContent = `${S.axis.toLowerCase()} = ${p.toFixed(2)} ม.`;
    $('colorbar').classList.remove('hidden');
  } else {
    viewer.hideSlice();
    $('colorbar').classList.add('hidden');
  }

  const vmax = Math.max(0.3, solver.maxSpeed);
  if (S.showVec && solved) viewer.updateVectors(solver, S.axis, S.slicePos, vmax);
  else viewer.hideVectors();

  if (S.showPart && solved) viewer.updateParticles(solver, Math.min(0.05, dtReal), vmax);
  else viewer.hideParticles();

  $('sim-time').textContent = `${solver.time.toFixed(1)} s`;
  $('sim-steps').textContent = solver.steps.toLocaleString('th-TH');
  $('sim-state').textContent = S.running ? 'กำลังคำนวณ…' : (solved ? 'หยุดชั่วคราว' : 'พร้อม');

  if (solved) updateStats();
  refreshLiveProps();
}

function updateColorbar(lo, hi) {
  $('cb-title').textContent = S.field === 'T' ? 'อุณหภูมิ (°C)' : 'ความเร็วลม (m/s)';
  const dec = S.field === 'T' ? 1 : 2;
  $('cb-max').textContent = hi.toFixed(dec);
  $('cb-mid').textContent = ((hi + lo) / 2).toFixed(dec);
  $('cb-min').textContent = lo.toFixed(dec);
}

function updateStats() {
  const st = solver.stats();
  if (!st) return;
  const box = $('stats-body');
  const rows = [];

  if (S.mode === 'outdoor') {
    rows.push(['อุณหภูมิอากาศภายนอก', `<b>${S.ambient.toFixed(1)} °C</b>`]);
    for (const d of S.devices) {
      if (TYPES[d.type].kind !== 'cdu' || !d.on) continue;
      const sc = d._scDelta ?? 0;
      const cls = sc > 3 ? 'stat-bad' : sc > 1.5 ? 'stat-warn' : 'stat-good';
      rows.push([escapeHtml(d.name) + ' เข้าคอยล์', `<b class="${cls}">${(d._intakeT ?? S.ambient).toFixed(1)} °C (+${sc.toFixed(1)})</b>`]);
    }
    const worst = Math.max(0, ...S.devices.filter(d => d._scDelta != null).map(d => d._scDelta));
    rows.push(['ความเร็วลมสูงสุด', `<b>${st.maxV.toFixed(2)} m/s</b>`]);
    box.innerHTML = rows.map(r => `<div class="stat-row"><span>${r[0]}</span>${r[1]}</div>`).join('')
      + `<div class="stat-note">${worst > 3
        ? '⚠️ อากาศร้อนวนกลับเข้าคอยล์มาก ประสิทธิภาพจะตกและอาจตัดการทำงาน — ควรเพิ่มระยะห่าง เปลี่ยนทิศลมทิ้ง หรือย้ายสิ่งกีดขวาง'
        : worst > 1.5
          ? '⚠️ เริ่มมีอากาศร้อนวนกลับ ควรตรวจระยะห่างด้านดูดของคอยล์'
          : '✅ การระบายอากาศของคอยล์ร้อนอยู่ในเกณฑ์ดี'}</div>`;
  } else {
    const cCls = st.comfortPct > 75 ? 'stat-good' : st.comfortPct > 45 ? 'stat-warn' : 'stat-bad';
    const dCls = st.draftPct < 10 ? 'stat-good' : st.draftPct < 25 ? 'stat-warn' : 'stat-bad';
    rows.push(['อุณหภูมิห้องเฉลี่ย', `<b>${(solver.avgTemp ?? st.avgT).toFixed(1)} °C</b>`]);
    rows.push(['เฉลี่ยระดับคนอยู่ (0.1–1.8 ม.)', `<b>${st.avgT.toFixed(1)} °C</b>`]);
    rows.push(['ต่ำสุด / สูงสุด', `<b>${st.minT.toFixed(1)} / ${st.maxT.toFixed(1)} °C</b>`]);
    rows.push(['ความไม่สม่ำเสมอ', `<b>${(st.maxT - st.minT).toFixed(1)} K</b>`]);
    rows.push(['ความเร็วลมเฉลี่ย', `<b>${st.avgV.toFixed(2)} m/s</b>`]);
    rows.push(['อยู่ในช่วงสบาย 22–26 °C', `<b class="${cCls}">${st.comfortPct.toFixed(0)} %</b>`]);
    rows.push(['เสี่ยงลมโกรก (&gt;0.25 m/s)', `<b class="${dCls}">${st.draftPct.toFixed(0)} %</b>`]);
    box.innerHTML = rows.map(r => `<div class="stat-row"><span>${r[0]}</span>${r[1]}</div>`).join('')
      + `<div class="stat-note">${st.comfortPct > 75 && st.draftPct < 15
        ? '✅ การกระจายลมเย็นสม่ำเสมอ อยู่ในเกณฑ์สบาย'
        : st.comfortPct < 45
          ? '⚠️ ยังเย็นไม่ทั่วถึง — ลองเพิ่มขนาด BTU ปรับมุมบานเกล็ด หรือย้ายตำแหน่งเครื่อง'
          : '⚠️ ลองปรับมุมบานเกล็ด/อัตราลม เพื่อลดจุดที่เย็นเกินหรือร้อนค้าง'}</div>`;
  }
  $('stats-overlay').classList.remove('hidden');
}

/* ═══════════ วงรอบหลัก ═══════════ */

let lastFrame = performance.now();
let fpsAcc = 0, fpsN = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (S.running) {
    const t0 = performance.now();
    let guard = 0;
    do {
      const dt = solver.suggestDt();
      updateSupplyTemps(solver, S.devices, bound, S.ambient);
      solver.step(dt);
      guard++;
    } while (performance.now() - t0 < S.budget && guard < 40);
  }

  updateVisuals(dtReal);
  viewer.render();

  fpsAcc += dtReal; fpsN++;
  if (fpsAcc > 0.5) {
    $('st-fps').textContent = `${Math.round(fpsN / fpsAcc)} fps`;
    fpsAcc = 0; fpsN = 0;
  }
}

/* ═══════════ บันทึก / เปิดไฟล์ ═══════════ */

function saveProject() {
  const data = {
    app: 'AirFlow Studio', version: 1,
    mode: S.mode, room: S.room, ambient: S.ambient, mesh: S.mesh, wind: S.wind,
    devices: S.devices.map(d => ({ ...d, _returnT: undefined, _supplyT: undefined, _intakeT: undefined, _scDelta: undefined, _load: undefined })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `airflow-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('บันทึกโปรเจกต์แล้ว');
}

function loadProjectData(data) {
  S.mode = data.mode === 'outdoor' ? 'outdoor' : 'indoor';
  S.room = { W: +data.room.W, H: +data.room.H, D: +data.room.D };
  S.ambient = +data.ambient;
  S.mesh = +data.mesh || 0.15;
  S.wind = data.wind ? { speed: +data.wind.speed || 0, dirDeg: +data.wind.dirDeg || 0 } : { speed: 0, dirDeg: 0 };
  S.devices = [];
  S.selected = null;
  for (const raw of data.devices || []) {
    if (!TYPES[raw.type]) continue;
    const d = createDevice(raw.type, { x: raw.pos?.x ?? 1, z: raw.pos?.z ?? 1 }, S.room.H);
    Object.assign(d, raw, { id: d.id, pos: { x: raw.pos?.x ?? 1, y: 0, z: raw.pos?.z ?? 1 } });
    if (raw.size) d.size = { ...d.size, ...raw.size };
    if (raw.btu && raw.flow == null) d.flow = autoFlow(d.type, d.btu);
    placeY(d, S.room.H);
    S.devices.push(d);
  }
  // ตั้งมุมมองผลลัพธ์ให้เหมาะกับงานที่เพิ่งเปิด
  S.field = 'T';
  S.axis = 'Y';
  S.slicePos = S.mode === 'outdoor' ? 0.18 : 0.45;   // outdoor: ระดับคอยล์ร้อน
  smoothLo = smoothHi = null;
  syncInputsFromState();
  domainKey = '';
  rebuild();
  select(null);
}

function loadPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  loadProjectData(p);
  setStatus(`โหลดตัวอย่าง: ${p.label} — กด "เริ่มคำนวณ" ที่แท็บคำนวณ`);
  setRibbon('solve');
}

function syncInputsFromState() {
  $('room-w').value = S.room.W;
  $('room-h').value = S.room.H;
  $('room-d').value = S.room.D;
  $('ambient-t').value = S.ambient;
  $('mesh-size').value = S.mesh.toFixed(2);
  $('wind-speed').value = S.wind.speed;
  $('wind-dir').value = S.wind.dirDeg;
  $('res-field').value = S.field;
  $('res-axis').value = S.axis;
  $('res-pos').value = S.slicePos;
}

/* ═══════════ การผูก UI ═══════════ */

function setRibbon(tab) {
  document.querySelectorAll('.rtab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.rpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
}

function bindUI() {
  document.querySelectorAll('.rtab').forEach(b => b.onclick = () => setRibbon(b.dataset.tab));

  $('btn-mode-indoor').onclick = () => switchMode('indoor');
  $('btn-mode-outdoor').onclick = () => switchMode('outdoor');

  for (const [id, key] of [['room-w', 'W'], ['room-h', 'H'], ['room-d', 'D']]) {
    $(id).onchange = () => {
      const v = Math.max(1, parseFloat($(id).value) || 1);
      $(id).value = v; S.room[key] = v;
      clampDevices();
      rebuild();
      setStatus('ปรับขนาดโดเมนแล้ว — ผลการคำนวณถูกรีเซ็ต');
    };
  }

  $('ambient-t').onchange = () => {
    S.ambient = parseFloat($('ambient-t').value) || 32;
    solver.ambient = S.ambient;
    rebuild();
  };
  $('mesh-size').onchange = () => { S.mesh = parseFloat($('mesh-size').value); rebuild(); };
  $('wind-speed').onchange = () => { S.wind.speed = Math.max(0, parseFloat($('wind-speed').value) || 0); solver.wind = S.wind; };
  $('wind-dir').onchange = () => { S.wind.dirDeg = parseFloat($('wind-dir').value) || 0; solver.wind = S.wind; };

  document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addDevice(b.dataset.add));

  $('btn-rotate').onclick = () => {
    const d = getSelected();
    if (!d) return setStatus('เลือกวัตถุก่อน แล้วจึงกดหมุน');
    d.yaw = (d.yaw + 90) % 360;
    clampDevices();
    rebuild();
    refreshProps();
  };
  $('btn-delete').onclick = () => {
    if (!S.selected) return setStatus('เลือกวัตถุก่อน แล้วจึงกดลบ');
    removeDevice(S.selected);
  };
  $('btn-clear').onclick = () => {
    if (!S.devices.length) return;
    S.devices = []; S.selected = null;
    rebuild(); select(null);
    setStatus('ล้างวัตถุทั้งหมดแล้ว');
  };
  $('btn-preset').onclick = () => loadPreset($('preset-select').value);

  $('btn-run').onclick = () => {
    if (!S.devices.some(d => ['ac', 'cdu'].includes(TYPES[d.type].kind) && d.on)) {
      return setStatus('ยังไม่มีเครื่องปรับอากาศที่เปิดใช้งาน — เพิ่มอุปกรณ์ที่แท็บแบบจำลองก่อน');
    }
    S.running = true;
    setStatus('กำลังคำนวณ — ดูผลได้ทันทีที่แท็บผลลัพธ์');
    setRibbon('results');
  };
  $('btn-pause').onclick = () => { S.running = false; setStatus('พักการคำนวณ'); };
  $('btn-reset').onclick = () => {
    S.running = false;
    solver.reset();
    smoothLo = smoothHi = null;
    setStatus('รีเซ็ตผลการคำนวณแล้ว');
  };
  $('sim-speed').onchange = () => { S.budget = +$('sim-speed').value; };

  $('res-field').onchange = () => { S.field = $('res-field').value; smoothLo = smoothHi = null; };
  $('res-axis').onchange = () => { S.axis = $('res-axis').value; };
  $('res-pos').oninput = () => { S.slicePos = +$('res-pos').value; };
  $('res-show-slice').onchange = () => { S.showSlice = $('res-show-slice').checked; };
  $('res-vectors').onchange = () => { S.showVec = $('res-vectors').checked; };
  $('res-particles').onchange = () => { S.showPart = $('res-particles').checked; };
  $('res-auto').onchange = () => {
    S.autoRange = $('res-auto').checked;
    $('res-min').disabled = S.autoRange;
    $('res-max').disabled = S.autoRange;
  };
  $('res-min').onchange = () => { S.lo = parseFloat($('res-min').value); };
  $('res-max').onchange = () => { S.hi = parseFloat($('res-max').value); };

  $('btn-view-iso').onclick = () => viewer.viewPreset('iso');
  $('btn-view-top').onclick = () => viewer.viewPreset('top');
  $('btn-view-front').onclick = () => viewer.viewPreset('front');
  $('btn-view-fit').onclick = () => viewer.viewFit();

  $('btn-save').onclick = saveProject;
  $('btn-load').onclick = () => $('file-load').click();
  $('file-load').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      loadProjectData(JSON.parse(await f.text()));
      setStatus(`เปิดโปรเจกต์ ${f.name} แล้ว`);
    } catch (err) {
      setStatus(`เปิดไฟล์ไม่สำเร็จ: ${err.message}`);
    }
    e.target.value = '';
  };

  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'Delete' && S.selected) removeDevice(S.selected);
    else if ((e.key === 'r' || e.key === 'R') && S.selected) $('btn-rotate').onclick();
    else if (e.key === 'Escape') select(null);
    else if (e.key === ' ') { e.preventDefault(); S.running = !S.running; }
  });
}

function switchMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode;
  S.running = false;
  if (mode === 'outdoor') {
    S.room = { W: 8, H: 4, D: 6 };
    S.ambient = 35;
  } else {
    S.room = { W: 5, H: 2.7, D: 4 };
    S.ambient = 32;
  }
  S.devices = [];
  S.selected = null;
  syncInputsFromState();
  domainKey = '';
  rebuild();
  select(null);
  setStatus(mode === 'outdoor'
    ? 'โหมดภายนอก: ขอบโดเมนเปิดให้อากาศไหลผ่านได้ — เหมาะกับการตรวจการวนกลับของลมร้อนที่คอยล์ร้อน'
    : 'โหมดภายใน: ผนังห้องทึบทุกด้าน — เหมาะกับการดูการกระจายลมเย็นในห้อง');
}

/** ดึงวัตถุที่หลุดออกนอกโดเมนกลับเข้ามา (หลังเปลี่ยนขนาดห้องหรือหมุน) */
function clampDevices() {
  for (const d of S.devices) {
    const swap = d.yaw === 90 || d.yaw === 270;
    const fx = (swap ? d.size.z : d.size.x) / 2;
    const fz = (swap ? d.size.x : d.size.z) / 2;
    d.pos.x = Math.max(Math.min(fx, S.room.W / 2), Math.min(d.pos.x, Math.max(S.room.W - fx, S.room.W / 2)));
    d.pos.z = Math.max(Math.min(fz, S.room.D / 2), Math.min(d.pos.z, Math.max(S.room.D - fz, S.room.D / 2)));
    placeY(d, S.room.H);
  }
}

/* ═══════════ เริ่มต้น ═══════════ */

function init() {
  viewer = new Viewer($('viewport'));
  viewer.onSelect = (id) => select(id);
  viewer.onDragEnd = () => { rebuild(true); refreshProps(); };

  bindUI();
  syncInputsFromState();
  loadPreset('bedroom');
  setRibbon('geometry');
  setStatus('พร้อมใช้งาน — โหลดตัวอย่าง "ห้องนอน" ไว้ให้แล้ว กด ▶️ เริ่มคำนวณ ที่แท็บคำนวณ');
  requestAnimationFrame(frame);
}

init();
