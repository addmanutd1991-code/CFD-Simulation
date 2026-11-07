/*
 * main.js — ตัวควบคุมหลัก: เชื่อมหน้าจอ ↔ ข้อมูลฉาก ↔ มุมมอง 3D ↔ ตัวคำนวณ
 */

import { MODELS, getModel, unitSize, status as unitStatus, MODULE_H, MODULE_D } from './models.js';
import { newScene, makeObject, domainOf, presetScene, PRESETS, normalizeScene, BC_FACES, insideRect } from './scene.js';
import { buildMesh } from './mesher.js';
import { Viewer, CONTOUR_LEVELS } from './viewer.js';
import { Runner } from './runner.js';
import { cssGradient, FIELDS, rgb } from './colormap.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const AUTOSAVE = 'cdu-airflow-cfd:scene';

/* ───────── สถานะ ───────── */

let scene = loadAutosave() || presetScene('rooftop');
let selectedId = null;
let tool = 'select';
const undoStack = [], redoStack = [];
const lastUsed = { model: 'RXQ16BY1S', rot: 0, wallHeight: 2.4, louver: 50 };
const run = {
  state: 'idle',      // idle | running | paused | done
  mesh: null, report: null, fields: null, stale: false,
  sceneJSON: null, startWall: 0, rate: null, lastT: 0, lastWall: 0,
};
const compare = [];

/* ───────── มุมมอง 3D ───────── */

const viewer = new Viewer($('#viewport'), {
  onSelect: (id) => select(id),
  // คลิกโดนวัตถุเดิมขณะถือเครื่องมือวาง → กลับโหมดเลือกแล้วเลือกวัตถุนั้น (ไม่วางซ้ำทับ)
  onPickWhileTool: (id) => { setTool('select'); select(id); },
  onMoveCommit: (id, dx, dz) => moveObject(id, dx, dz),
  onOffset: (id, dx, dz) => offsetObject(id, dx, dz),
  onTransform: (id, q, copy) => applyTransform(id, q, copy),
  onToolDone: () => setTool('select'),
  onBeginEdit: () => pushUndo(),
  onObjectEdited: () => afterChange(true),
  onCreate: (type, props) => createObject(type, props),
  onSectionMoved: (pos) => syncSectionUI(pos),
  onProbe: (info) => showProbe(info),
  newCduModel: () => lastUsed.model,
  newCduRot: () => lastUsed.rot,
  newWallHeight: () => lastUsed.wallHeight,
});

const runner = new Runner(onEngineMessage);

/* ───────── การแก้ไขฉาก ───────── */

function pushUndo() {
  undoStack.push(JSON.stringify(scene));
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

function edit(fn, geom = true) {
  pushUndo();
  fn();
  afterChange(geom);
}

function afterChange(geom = true) {
  const dom = domainOf(scene);
  viewer.setModel(scene, dom);
  if (!scene.objects.some(o => o.id === selectedId)) selectedId = null;
  viewer.setSelected(selectedId);
  renderProps();
  renderSettings();
  updateEstimate();
  syncSectionUI();
  $('#empty-hint').hidden = scene.objects.length > 0;
  updateBandLegend();
  saveAutosave();
  if (geom) invalidate();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(scene));
  scene = JSON.parse(undoStack.pop());
  updateUndoButtons();
  afterChange(true);
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(scene));
  scene = JSON.parse(redoStack.pop());
  updateUndoButtons();
  afterChange(true);
}

function updateUndoButtons() {
  $('#btn-undo').disabled = !undoStack.length;
  $('#btn-redo').disabled = !redoStack.length;
}

function createObject(type, props) {
  pushUndo();
  let o;
  if (type === 'cdu') {
    // วางบนแผ่นพื้นยก/หลังคา → ยกฐานเครื่องขึ้นไปบนผิวแผ่น
    const sup = scene.objects.filter(s => s.type === 'slab' && insideRect(s, props.x, props.z))
      .reduce((m, s) => Math.max(m, s.y), 0);
    o = makeObject(scene, 'cdu', { ...props, model: lastUsed.model, rot: lastUsed.rot, ...(sup > 0 ? { elev: round2(sup + 0.2) } : {}) });
  }
  else if (type === 'wall') o = makeObject(scene, 'wall', { ...props, height: lastUsed.wallHeight, louver: lastUsed.louver });
  else if (type === 'slab') o = makeObject(scene, 'slab', props);
  else o = makeObject(scene, 'building', props);
  scene.objects.push(o);
  selectedId = o.id;
  afterChange(true);
}

function select(id) {
  selectedId = id;
  viewer.setSelected(id);
  renderProps();
  $$('#res-table tbody tr').forEach(tr => tr.classList.toggle('sel', Number(tr.dataset.id) === id));
}

function selected() { return scene.objects.find(o => o.id === selectedId) || null; }

function deleteSelected() {
  const o = selected();
  if (!o) return;
  edit(() => { scene.objects = scene.objects.filter(q => q.id !== o.id); selectedId = null; });
}

function duplicateSelected() {
  const o = selected();
  if (!o) return;
  edit(() => {
    const c = makeObject(scene, o.type, { ...o, id: undefined, name: undefined });
    const off = 1.5;
    if (o.type === 'wall') { c.x1 += off; c.x2 += off; c.z1 += off; c.z2 += off; }
    else { c.x += o.type === 'cdu' ? unitSize(o).w + 0.8 : off; c.z += o.type === 'cdu' ? 0 : off; }
    scene.objects.push(c);
    selectedId = c.id;
  });
}

function rotateSelected() {
  const o = selected();
  if (!o) return;
  edit(() => {
    if (o.type === 'cdu') { o.rot = (o.rot + 90) % 360; lastUsed.rot = o.rot; }
    else if (o.type === 'building' || o.type === 'slab') o.rot = (o.rot + 90) % 360;
    else {
      // หมุนผนังรอบจุดกึ่งกลาง 90° ทวนเข็ม (มุมมอง Top) — ทิศเดียวกับ CDU/อาคาร และคำสั่ง Rotate
      const cx = (o.x1 + o.x2) / 2, cz = (o.z1 + o.z2) / 2;
      const r = (x, z) => [round3(cx + (z - cz)), round3(cz - (x - cx))];
      [o.x1, o.z1] = r(o.x1, o.z1); [o.x2, o.z2] = r(o.x2, o.z2);
    }
  });
}

/* ───────── คัดลอก / ตัด / วาง (Ctrl+C / X / V) ───────── */

let clipboard = null, pasteN = 0;

function copySelected(cut = false) {
  const o = selected();
  if (!o) { toast('เลือกวัตถุก่อน แล้วกด Ctrl+C'); return; }
  clipboard = JSON.parse(JSON.stringify(o));
  pasteN = 0;
  if (cut) {
    edit(() => { scene.objects = scene.objects.filter(q => q.id !== o.id); selectedId = null; });
    toast(`ตัด ${o.name} แล้ว — ชี้เมาส์ตรงจุดที่ต้องการแล้วกด Ctrl+V`);
  } else toast(`คัดลอก ${o.name} แล้ว — ชี้เมาส์ตรงจุดที่ต้องการแล้วกด Ctrl+V (วางซ้ำได้)`);
}

const refPoint = o => (o.type === 'wall' ? { x: (o.x1 + o.x2) / 2, z: (o.z1 + o.z2) / 2 } : { x: o.x, z: o.z });
/** ระดับผิวแผ่นพื้น/หลังคาที่รองรับ ณ จุด (x, z) */
const supportAt = (x, z) => scene.objects.filter(s => s.type === 'slab' && insideRect(s, x, z)).reduce((m, s) => Math.max(m, s.y), 0);

function pasteClipboard() {
  if (!clipboard) { toast('ยังไม่ได้คัดลอก — เลือกวัตถุแล้วกด Ctrl+C ก่อน'); return; }
  const src = clipboard, r = refPoint(src);
  // วาง ณ ตำแหน่งเมาส์บนพื้น — ถ้าเมาส์ไม่อยู่บนมุมมอง วางเยื้องจากต้นฉบับทีละ 1 ม.
  let p = viewer.cursorPoint();
  if (!p) { pasteN++; p = { x: r.x + pasteN, z: r.z + pasteN }; }
  const dx = p.x - r.x, dz = p.z - r.z;
  edit(() => {
    const c = makeObject(scene, src.type, { ...src, id: undefined, name: undefined });
    translateObj(c, dx, dz);
    reseatCdu(c, src);
    scene.objects.push(c);
    selectedId = c.id;
  });
}

/* ───────── Move / Offset (แบบ AutoCAD) ───────── */

function translateObj(o, dx, dz) {
  if (o.type === 'wall') { o.x1 = round3(o.x1 + dx); o.x2 = round3(o.x2 + dx); o.z1 = round3(o.z1 + dz); o.z2 = round3(o.z2 + dz); }
  else { o.x = round3(o.x + dx); o.z = round3(o.z + dz); }
  viewer.keepInside(o);
}

/** CDU: คงระยะฐานเหนือพื้นรองรับเมื่อย้ายข้ามแผ่นพื้น/หลังคา */
function reseatCdu(c, from) {
  if (c.type === 'cdu') c.elev = round2(Math.max(0, from.elev - supportAt(from.x, from.z)) + supportAt(c.x, c.z));
}

function moveObject(id, dx, dz) {
  const o = scene.objects.find(q => q.id === id);
  if (!o) return;
  edit(() => { const from = { ...o }; translateObj(o, dx, dz); reseatCdu(o, from); });
  toast(`ย้าย ${o.name} ${fmt(Math.hypot(dx, dz))} m`, 1800);
}

function offsetObject(id, dx, dz) {
  const o = scene.objects.find(q => q.id === id);
  if (!o) return;
  edit(() => {
    const c = makeObject(scene, o.type, { ...o, id: undefined, name: undefined });
    translateObj(c, dx, dz);
    reseatCdu(c, o);
    scene.objects.push(c);
    selectedId = c.id;
  });
}

/** Copy / Mirror / Rotate: q = วัตถุผลลัพธ์จากมุมมอง 3D · copy = สร้างวัตถุใหม่ (ต้นฉบับคงเดิม) */
function applyTransform(id, q, copy) {
  const o = scene.objects.find(x => x.id === id);
  if (!o) return;
  edit(() => {
    if (copy) {
      const c = makeObject(scene, o.type, { ...q, id: undefined, name: undefined });
      reseatCdu(c, o);
      scene.objects.push(c);
      selectedId = c.id;
    } else {
      const from = { ...o };
      Object.assign(o, q, { id: o.id, name: o.name });
      reseatCdu(o, from);
      if (o.type === 'cdu') lastUsed.rot = o.rot;
    }
  });
}

/** Tab / Shift+Tab: เลือกวัตถุถัดไป/ก่อนหน้า (ช่วยเลือกวัตถุที่ถูกบังหรือซ้อนกัน) */
function cycleSelection(dir) {
  const list = scene.objects;
  if (!list.length) return;
  const i = list.findIndex(o => o.id === selectedId);
  const n = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  if (tool !== 'select') setTool('select');
  select(list[n].id);
}

let ortho = false;
function setOrtho(on) {
  ortho = on;
  viewer.setOrtho(on);
  $('#btn-ortho').classList.toggle('on', on);
  toast(on ? 'Ortho เปิด — ผนัง/Move ล็อกตามแนวแกน X/Z (Shift = ปลดชั่วคราว)' : 'Ortho ปิด', 1600);
}

function toggleKeys(show) {
  const el = $('#keys-pop');
  el.hidden = show === undefined ? !el.hidden : !show;
}

function nudge(dx, dz) {
  const o = selected();
  if (!o) return;
  edit(() => {
    if (o.type === 'wall') { o.x1 += dx; o.x2 += dx; o.z1 += dz; o.z2 += dz; }
    else { o.x = round2(o.x + dx); o.z = round2(o.z + dz); }
  });
}

/* ───────── เครื่องมือ ───────── */

const TOOL_HINT = {
  cdu: 'คลิกบนพื้นภายในกริดแกนเพื่อวาง CDU · วางต่อได้หลายตัว · คลิกโดนวัตถุเดิม = เลือกเพื่อแก้ไข · Esc เพื่อจบ',
  wall: 'คลิกจุดเริ่ม แล้วคลิกจุดถัดไป (ต่อเนื่องได้ ภายในกริดแกน) · พิมพ์ความยาว (ม.) + Enter ตามทิศเมาส์ · F8 Ortho / Shift ล็อกแนวแกน · คลิกกลางผนังเดิม = เลือก · ดับเบิลคลิก/Esc เพื่อจบ',
  slab: 'คลิกมุมหนึ่งของแผ่นพื้น/หลังคา แล้วคลิกมุมตรงข้าม · ตั้งระดับความสูงที่แผงด้านขวา · Esc เพื่อจบ',
  move: 'Move: เลือกวัตถุ → จุดฐาน → จุดที่สอง หรือพิมพ์ระยะ + Enter · F8 Ortho · Esc ยกเลิก',
  copy: 'Copy: เลือกวัตถุ → จุดฐาน → คลิกวางสำเนาได้หลายครั้ง หรือพิมพ์ระยะ + Enter · F8 Ortho · Esc จบ',
  mirror: 'Mirror: เลือกวัตถุ → คลิกจุดแรกและจุดที่สองของเส้นสะท้อน (ได้สำเนา ต้นฉบับคงเดิม) · F8 Ortho · Esc ยกเลิก',
  rotate: 'Rotate: เลือกวัตถุ → จุดฐาน → พิมพ์มุม (องศา, + ทวนเข็ม / − ตามเข็ม) + Enter หรือคลิก · CDU ทีละ 90° · Esc ยกเลิก',
  offset: 'Offset: พิมพ์ระยะ + Enter → คลิกวัตถุ → คลิกฝั่ง (CDU/อาคาร = ช่องว่างระหว่างขอบ) · Esc จบ',
  building: 'คลิกมุมหนึ่งของอาคาร แล้วคลิกมุมตรงข้าม · Esc เพื่อจบ',
};

function setTool(t) {
  tool = t;
  viewer.setTool(t);
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  const th = $('#toolhint');
  th.hidden = t === 'select';
  th.textContent = TOOL_HINT[t] || '';
}

/* ───────── แผงคุณสมบัติ ───────── */

const TYPE_ICON = { cdu: 'CDU', wall: 'W', building: 'B', slab: 'F' };
const TYPE_TITLE = { cdu: 'คอยล์ร้อน (CDU)', wall: 'ผนัง / louver', building: 'อาคาร', slab: 'พื้น / หลังคา' };

function renderProps() {
  const box = $('#props');
  const o = selected();
  if (!o) {
    $('#props-title').textContent = `วัตถุในฉาก (${scene.objects.length})`;
    if (!scene.objects.length) {
      box.innerHTML = '<p class="muted small">ยังไม่มีวัตถุ — ใช้ปุ่ม + CDU / + ผนัง / + อาคาร / + พื้น ด้านบน</p>';
      return;
    }
    const order = { cdu: 0, wall: 1, building: 2, slab: 3 };
    const items = [...scene.objects].sort((a, b) => order[a.type] - order[b.type] || a.id - b.id);
    box.innerHTML = `<ul class="obj-list">${items.map(q => `
      <li data-id="${q.id}"><span class="ico">${TYPE_ICON[q.type]}</span>${esc(q.name)}
      <span class="sub">${q.type === 'cdu' ? esc(q.model) : q.type === 'wall' ? (q.louver > 0 ? 'louver ' + q.louver + '%' : 'ทึบ') : q.type === 'slab' ? '+' + fmt(q.y) + ' m' + (q.open > 0 ? ' · เปิด ' + q.open + '%' : '') : fmt(q.h) + ' m'}</span></li>`).join('')}</ul>
      <p class="muted small" style="margin:8px 2px 0">คลิกรายการหรือคลิกวัตถุใน 3D เพื่อแก้ไข</p>`;
    $$('li', box).forEach(li => li.addEventListener('click', () => select(Number(li.dataset.id))));
    return;
  }

  $('#props-title').textContent = TYPE_TITLE[o.type];
  let html = `<div class="form">
    <label class="row">ชื่อ <input type="text" data-k="name" value="${esc(o.name)}"></label>`;
  if (o.type === 'cdu') {
    const m = getModel(o.model);
    const opts = (single) => MODELS.filter(x => (x.modules.length === 1) === single)
      .map(x => `<option value="${x.id}" ${x.id === o.model ? 'selected' : ''}>${x.id} — ${x.hp} HP · ${x.kw.toFixed(1)} kW</option>`).join('');
    const sz = unitSize(o);
    html += `
      <label class="row">รุ่น <select data-k="model"><optgroup label="โมดูลเดี่ยว">${opts(true)}</optgroup><optgroup label="ชุดคอมบิเนชัน">${opts(false)}</optgroup></select></label>
      <div class="row">ตำแหน่ง x, z (ม.) <span class="xz"><input type="number" step="0.1" data-k="x" value="${fmt(o.x)}"><input type="number" step="0.1" data-k="z" value="${fmt(o.z)}"></span></div>
      <div class="row">ด้านหน้าเครื่องหันไป <div class="seg" data-seg="rot">
        ${[[0, 'ใต้'], [90, 'ตอ.'], [180, 'เหนือ'], [270, 'ตต.']].map(([v, l]) => `<button data-v="${v}" class="${o.rot === v ? 'on' : ''}">${l}</button>`).join('')}
      </div></div>
      <label class="row">ความสูงฐาน (ม.) <input type="number" step="0.05" min="0" max="60" data-k="elev" value="${fmt(o.elev)}"></label>
      <label class="row">ท่อเป่าลมเหนือพัดลม (ม.) <input type="number" step="0.1" min="0" max="3" data-k="duct" value="${fmt(o.duct || 0)}"></label>
      <label class="row">อัตราลม (m³/min) <input type="number" step="1" min="30" max="2000" data-k="airflow" value="${fmt(o.airflow || m.cmm)}"></label>
      <div class="spec">
        ${m.modules.length > 1 ? `ชุด <b>${m.modules.map(h => h + 'HP').join(' + ')}</b> · ` : ''}ทำความเย็น <b>${m.kw.toFixed(1)} kW</b> · EER <b>${m.eer.toFixed(2)}</b><br>
        ขนาด <b>${Math.round(sz.w * 1000)} × ${MODULE_H} × ${MODULE_D}</b> มม. · พัดลม <b>${m.fans}</b> ใบ<br>
        อัตราลมมาตรฐาน <b>${m.cmm}</b> m³/min${o.airflow ? ` · <a href="#" data-reset-air>ใช้ค่ามาตรฐาน</a>` : ''}
      </div>`;
    const ur = unitsNow()?.find(u => u.id === o.id);
    if (ur) {
      html += `<div class="unit-res st-${ur.status.key}">T ลมเข้า <span>${ur.Tin.toFixed(1)} °C</span> (ΔT <span>+${ur.dT.toFixed(2)} °C</span>)
        · ลมวนกลับ <span>${(ur.Cin * 100).toFixed(1)}%</span><br>capacity <span>${(ur.capF * 100).toFixed(1)}%</span>
        = <span>${ur.kwAvail.toFixed(1)}</span> / ${ur.kwRated.toFixed(1)} kW · <b class="st-${ur.status.key}">${ur.status.label}</b></div>`;
    }
  } else if (o.type === 'wall') {
    const L = Math.hypot(o.x2 - o.x1, o.z2 - o.z1);
    html += `
      <div class="row">จุดเริ่ม x, z <span class="xz"><input type="number" step="0.1" data-k="x1" value="${fmt(o.x1)}"><input type="number" step="0.1" data-k="z1" value="${fmt(o.z1)}"></span></div>
      <div class="row">จุดปลาย x, z <span class="xz"><input type="number" step="0.1" data-k="x2" value="${fmt(o.x2)}"><input type="number" step="0.1" data-k="z2" value="${fmt(o.z2)}"></span></div>
      <label class="row">ความยาว (ม.) <input type="number" step="0.1" min="0.1" data-wall="len" value="${fmt(L)}"></label>
      <label class="row">มุมแนวผนัง (°) <input type="number" step="15" data-wall="ang" value="${fmt(wallAngle(o))}"></label>
      <div class="row">ยืดความยาวจาก <div class="seg" data-seg="anchor">
        ${[['start', 'จุดเริ่ม'], ['mid', 'กึ่งกลาง'], ['end', 'จุดปลาย']].map(([v, l]) => `<button data-v="${v}" class="${wallAnchor === v ? 'on' : ''}">${l}</button>`).join('')}
      </div></div>
      <label class="row">ความสูง (ม.) <input type="number" step="0.1" min="0.2" max="30" data-k="height" value="${fmt(o.height)}"></label>
      <label class="row">ความหนา (ม.) <input type="number" step="0.05" min="0.05" max="1" data-k="thick" value="${fmt(o.thick)}"></label>
      <label class="row">ช่องว่างใต้ผนัง (ม.) <input type="number" step="0.1" min="0" max="5" data-k="gap" value="${fmt(o.gap || 0)}"></label>
      <label class="row">พื้นที่เปิด louver <span class="mono val">${o.louver > 0 ? o.louver + '%' : 'ทึบ'}</span></label>
      <input type="range" min="0" max="95" step="5" data-k="louver" value="${o.louver}">
      <p class="note">0% = ผนังทึบ · louver ทั่วไปมีพื้นที่เปิด 40–60% · พิมพ์ความยาว/มุมได้โดยตรง หรือลากปุ่มกลมที่ปลายผนัง
        · มุม 0° = ไปทางตะวันออก (+x), 90° = ไปทางใต้ (+z)</p>`;
  } else if (o.type === 'slab') {
    html += `
      <div class="row">ศูนย์กลาง x, z <span class="xz"><input type="number" step="0.1" data-k="x" value="${fmt(o.x)}"><input type="number" step="0.1" data-k="z" value="${fmt(o.z)}"></span></div>
      <div class="row">กว้าง × ยาว (ม.) <span class="xz"><input type="number" step="0.1" min="0.3" data-k="w" value="${fmt(o.w)}"><input type="number" step="0.1" min="0.3" data-k="d" value="${fmt(o.d)}"></span></div>
      <label class="row">ระดับผิวบน (ม.) <input type="number" step="0.1" min="0" max="60" data-k="y" value="${fmt(o.y)}"></label>
      <label class="row">ความหนา (ม.) <input type="number" step="0.05" min="0.05" max="2" data-k="thick" value="${fmt(o.thick)}"></label>
      <label class="row">มุมหมุน (°) <input type="number" step="15" data-k="rot" value="${fmt(o.rot)}"></label>
      <label class="row">ช่องเปิด (ตะแกรง) <span class="mono val">${o.open > 0 ? o.open + '%' : 'ทึบ'}</span></label>
      <input type="range" min="0" max="95" step="5" data-k="open" value="${o.open || 0}">
      <p class="note">ใช้เป็นพื้นยก (ชั้นลอย/แท่นวางเครื่อง) หรือหลังคาคลุมลาน · ผิวบนอยู่ที่ระดับที่ตั้ง หนาลงด้านล่าง
        · 0% = แผ่นทึบ (คอนกรีต/หลังคา) · ตะแกรงเหล็ก (grating) ทั่วไปเปิด 60–80%
        · CDU ที่วางบนแผ่นนี้จะยกฐานขึ้นไปบนผิวแผ่นอัตโนมัติ</p>`;
  } else {
    html += `
      <div class="row">ศูนย์กลาง x, z <span class="xz"><input type="number" step="0.1" data-k="x" value="${fmt(o.x)}"><input type="number" step="0.1" data-k="z" value="${fmt(o.z)}"></span></div>
      <div class="row">กว้าง × ลึก (ม.) <span class="xz"><input type="number" step="0.1" min="0.3" data-k="w" value="${fmt(o.w)}"><input type="number" step="0.1" min="0.3" data-k="d" value="${fmt(o.d)}"></span></div>
      <label class="row">ความสูง (ม.) <input type="number" step="0.1" min="0.3" max="60" data-k="h" value="${fmt(o.h)}"></label>
      <label class="row">มุมหมุน (°) <input type="number" step="15" data-k="rot" value="${fmt(o.rot)}"></label>`;
  }
  html += `</div>
    <div class="props-actions">
      <button data-act="dup" title="Ctrl+D">ทำสำเนา</button>
      <button data-act="rot" title="หมุน 90° ทวนเข็ม (R)">หมุน 90°</button>
      <button data-act="del" class="danger" title="Delete">ลบ</button>
      <span class="spacer"></span>
      <button data-act="close" class="ghost" title="Esc">ปิด</button>
    </div>`;
  box.innerHTML = html;

  const NUM = new Set(['x', 'z', 'elev', 'duct', 'airflow', 'x1', 'z1', 'x2', 'z2', 'height', 'thick', 'gap', 'louver', 'w', 'd', 'h', 'rot', 'y', 'open']);
  $$('[data-k]', box).forEach(inp => {
    const k = inp.dataset.k;
    const ev = inp.type === 'range' ? 'input' : 'change';
    inp.addEventListener(ev, () => {
      let v = inp.value;
      if (NUM.has(k)) {
        v = parseFloat(v);
        if (!isFinite(v)) { renderProps(); return; }
        if (k === 'elev' || k === 'duct' || k === 'gap' || k === 'y') v = Math.max(0, v);
        if (k === 'height' || k === 'h' || k === 'w' || k === 'd' || k === 'thick') v = Math.max(0.05, v);
      }
      if (inp.type === 'range') {
        // เลื่อนแถบ: บันทึก undo ครั้งเดียวต่อการลาก
        if (!inp._pushed) { pushUndo(); inp._pushed = true; }
        o[k] = v;
        if (k === 'louver') lastUsed.louver = v;
        inp.previousElementSibling?.querySelector('.val') && (inp.previousElementSibling.querySelector('.val').textContent = v > 0 ? v + '%' : 'ทึบ');
        viewer.refreshObject(o);
        invalidate();
        saveAutosave();
        return;
      }
      if (k === 'airflow' && Math.abs(v - getModel(o.model).cmm) < 0.5) v = null;
      edit(() => {
        o[k] = v;
        if (k === 'model') { lastUsed.model = v; o.airflow = null; }
        if (k === 'height' && o.type === 'wall') lastUsed.wallHeight = v;
      }, k !== 'name');
    });
    if (inp.type === 'range') inp.addEventListener('change', () => { inp._pushed = false; afterChange(true); });
  });
  // ผนัง: แก้ความยาว/มุมโดยพิมพ์ค่า — คงตำแหน่งจุดยึดที่เลือกไว้
  $$('[data-wall]', box).forEach(inp => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) { renderProps(); return; }
    const L = inp.dataset.wall === 'len' ? Math.max(0.1, v) : Math.hypot(o.x2 - o.x1, o.z2 - o.z1);
    const a = (inp.dataset.wall === 'ang' ? v : wallAngle(o)) * Math.PI / 180;
    edit(() => setWallGeometry(o, L, a, wallAnchor));
  }));
  $$('[data-seg="anchor"] button', box).forEach(b => b.addEventListener('click', () => {
    wallAnchor = b.dataset.v;
    $$('[data-seg="anchor"] button', box).forEach(q => q.classList.toggle('on', q === b));
  }));
  $$('[data-seg="rot"] button', box).forEach(b => b.addEventListener('click', () => {
    edit(() => { o.rot = Number(b.dataset.v); lastUsed.rot = o.rot; });
  }));
  $('[data-reset-air]', box)?.addEventListener('click', (e) => { e.preventDefault(); edit(() => { o.airflow = null; }); });
  $('[data-act="dup"]', box).addEventListener('click', duplicateSelected);
  $('[data-act="rot"]', box).addEventListener('click', rotateSelected);
  $('[data-act="del"]', box).addEventListener('click', deleteSelected);
  $('[data-act="close"]', box).addEventListener('click', () => select(null));
}

let wallAnchor = 'start';

/** มุมแนวผนัง (องศา) จากจุดเริ่มไปจุดปลาย: 0° = +x (ตะวันออก), 90° = +z (ใต้) */
function wallAngle(o) {
  return Math.round(Math.atan2(o.z2 - o.z1, o.x2 - o.x1) * 180 / Math.PI * 100) / 100;
}

/** ตั้งความยาว L และมุม a (เรเดียน) ของผนัง โดยคงจุดยึด (จุดเริ่ม / กึ่งกลาง / จุดปลาย) ไว้ที่เดิม */
function setWallGeometry(o, L, a, anchor) {
  const dx = Math.cos(a) * L, dz = Math.sin(a) * L;
  let ax, az;
  if (anchor === 'end') { ax = o.x2 - dx; az = o.z2 - dz; }
  else if (anchor === 'mid') { ax = (o.x1 + o.x2) / 2 - dx / 2; az = (o.z1 + o.z2) / 2 - dz / 2; }
  else { ax = o.x1; az = o.z1; }
  const r3 = v => Math.round(v * 1000) / 1000;
  o.x1 = r3(ax); o.z1 = r3(az); o.x2 = r3(ax + dx); o.z2 = r3(az + dz);
}

/* ───────── ค่าตั้งสภาพแวดล้อม ───────── */

const SETTINGS = [
  ['#s-amb', 'site', 'ambient'], ['#s-wind', 'site', 'windSpeed'], ['#s-dir', 'site', 'windDir'],
  ['#s-cell', 'sim', 'cell'], ['#s-tmax', 'sim', 'tMax'],
  ['#p-tref', 'perf', 'Tref'], ['#p-tlim', 'perf', 'Tlimit'],
];

function renderSettings() {
  for (const [sel, g, k] of SETTINGS) $(sel).value = scene[g][k];
  $('#p-kcap').value = round2(scene.perf.kCap * 100);
  $('#p-kpow').value = round2(scene.perf.kPow * 100);
  $('#proj-name').value = scene.name;
  $('#b-green').value = scene.bands.green;
  $('#b-red').value = scene.bands.red;
  for (const f of BC_FACES) {
    const row = $(`[data-bc="${f}"]`);
    $('select', row).value = scene.bc[f].type;
    const d = $('input', row);
    if (d) d.value = scene.bc[f].dist;
  }
}

function bindSettings() {
  for (const [sel, g, k] of SETTINGS) {
    $(sel).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!isFinite(v)) { renderSettings(); return; }
      edit(() => { scene[g][k] = v; });
    });
  }
  $('#p-kcap').addEventListener('change', (e) => edit(() => { scene.perf.kCap = Math.max(0, parseFloat(e.target.value) || 0) / 100; }));
  $('#p-kpow').addEventListener('change', (e) => edit(() => { scene.perf.kPow = Math.max(0, parseFloat(e.target.value) || 0) / 100; }));
  $('#proj-name').addEventListener('change', (e) => { scene.name = e.target.value.trim() || 'โปรเจกต์'; saveAutosave(); });
  for (const f of BC_FACES) {
    const row = $(`[data-bc="${f}"]`);
    $('select', row).addEventListener('change', (e) => edit(() => { scene.bc[f].type = e.target.value; }));
    $('input', row)?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!isFinite(v)) { renderSettings(); return; }
      edit(() => { scene.bc[f].dist = Math.min(40, Math.max(0.5, v)); });
    });
  }
}

function bindBands() {
  for (const [id, k] of [['#b-green', 'green'], ['#b-red', 'red']]) {
    $(id).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      const nb = { ...scene.bands, [k]: v };
      if (!isFinite(v) || !(nb.red > nb.green)) { toast('เกณฑ์สีแดงต้องมากกว่าเกณฑ์สีเขียว'); renderSettings(); return; }
      pushUndo();
      scene.bands = nb;
      saveAutosave();
      viewer.refreshCduColors();
      updateBandLegend();
      renderResults();
    });
  }
}

/** ต้องมีขอบเปิดอย่างน้อยหนึ่งด้าน มิฉะนั้นความร้อนออกจากโดเมนไม่ได้และผลไม่มีวันนิ่ง */
function hasOpenFace() { return BC_FACES.some(f => scene.bc[f].type === 'open'); }

/** หน่วยความจำของ solver ≈ 112 ไบต์ต่อเซลล์ (รวมเซลล์ขอบ) — ดู Solver.memoryBytes */
const meshBytes = d => (d.nx + 2) * (d.ny + 2) * (d.nz + 2) * 112;
/** WebAssembly 32 บิตจองได้สูงสุด 4 GiB เผื่อสแตก/ส่วนอื่นไว้ 128 MiB */
const MAX_MESH_BYTES = 4 * 1024 ** 3 - 128 * 1024 ** 2;
const fmtGB = b => (b / 1024 ** 3).toFixed(1);

function updateEstimate() {
  const d = domainOf(scene);
  // โดยทั่วไปลู่เข้าในช่วง 60–150 วินาทีจำลอง — ประมาณที่ 120 s
  const steps = 120 / (0.25 * d.h);
  const sec = d.cells * 0.4e-6 * steps;   // ≈0.4 µs ต่อเซลล์ต่อสเต็ป (WebAssembly)
  const el = $('#mesh-info');
  el.textContent = `โดเมน ${fmt(d.W)} × ${fmt(d.D)} × ${fmt(d.H)} ม. · กริด ${d.nx}×${d.ny}×${d.nz} = ${fmtK(d.cells)} เซลล์ · หน่วยความจำ ≈ ${fmtGB(meshBytes(d))} GB`
    + (meshBytes(d) > MAX_MESH_BYTES ? ' — เกิน 4 GB คำนวณไม่ได้ ลดระยะเผื่อโดเมนหรือเพิ่มขนาดเซลล์' : '');
  el.classList.toggle('warn', d.cells > 1.2e6);
  if (run.state !== 'running') $('#estimate').textContent = scene.objects.some(o => o.type === 'cdu')
    ? `${fmtK(d.cells)} เซลล์ · ประมาณ ${fmtDur(sec)}` : '';
}

/* ───────── การคำนวณ ───────── */

function startOrToggle() {
  if (run.state === 'running') {
    runner.send({ cmd: 'pause' });
    run.state = 'paused';
    updateRunUI();
    return;
  }
  if (run.state === 'done' && run.report?.converged && !run.stale) {
    toast('ผลลู่เข้าแล้ว — แก้แบบหรือกด ↺ รีเซ็ตผล เพื่อคำนวณใหม่');
    return;
  }
  if ((run.state === 'paused' || run.state === 'done') && !run.stale && run.mesh) {
    run.state = 'running';
    run.lastWall = performance.now(); run.lastT = run.report?.time || 0;
    runner.send({ cmd: 'run' });
    updateRunUI();
    return;
  }
  if (!scene.objects.some(o => o.type === 'cdu')) { toast('ยังไม่มี CDU ในฉาก — กด + CDU แล้ววางเครื่องก่อน'); return; }
  if (!hasOpenFace()) { toast('ต้องมีขอบโดเมนแบบ "เปิด" อย่างน้อยหนึ่งด้าน ไม่เช่นนั้นลมร้อนออกไม่ได้และผลจะไม่ลู่เข้า', 5000); return; }
  const d = domainOf(scene);
  if (meshBytes(d) > MAX_MESH_BYTES) {
    toast(`เมชใหญ่เกินไป (${fmtK(d.cells)} เซลล์ ≈ ${fmtGB(meshBytes(d))} GB เกินหน่วยความจำสูงสุด 4 GB ของ WebAssembly) — เพิ่มขนาดเซลล์ หรือลดระยะเผื่อขอบโดเมน`, 6000);
    return;
  }
  if (d.cells > 1.2e6 && !confirm(`เมช ${fmtK(d.cells)} เซลล์ อาจใช้เวลานานมากและใช้หน่วยความจำสูง คำนวณต่อหรือไม่?`)) return;

  const mesh = buildMesh(scene);
  run.mesh = mesh;
  run.fields = null;
  run.report = null;
  run.stale = false;
  run.sceneJSON = JSON.stringify(scene);
  run.state = 'running';
  run.startWall = run.lastWall = performance.now();
  run.lastT = 0; run.rate = null;
  viewer.setResults(null);
  runner.send({
    cmd: 'init', mesh,
    params: { ambient: scene.site.ambient, windSpeed: scene.site.windSpeed, windDir: scene.site.windDir, perf: scene.perf, tMax: scene.sim.tMax },
  });
  runner.send({ cmd: 'run' });
  renderWarnings(mesh.warnings);
  updateRunUI();
}

function resetResults() {
  runner.send({ cmd: 'dispose' });
  run.state = 'idle';
  run.mesh = null; run.report = null; run.fields = null; run.stale = false;
  viewer.setResults(null);
  renderResults();
  updateRunUI();
}

/** แบบเปลี่ยน → หยุดการคำนวณ และทำเครื่องหมายว่าผลเก่า */
function invalidate() {
  if (!run.mesh || run.stale) return;
  if (run.state === 'running' || run.state === 'paused') runner.send({ cmd: 'pause' });
  run.state = 'idle';
  run.stale = true;
  viewer.setResults(null);
  renderResults();
  updateRunUI();
}

function onEngineMessage(msg) {
  if (msg.type === 'mode') {
    $('#foot-mode').textContent = 'คำนวณบน main thread (เบราว์เซอร์ไม่อนุญาต Web Worker) — ผลเหมือนเดิมแต่หน้าจออาจหน่วงเล็กน้อย';
    return;
  }
  if (!run.mesh || run.stale) return;
  if (msg.type === 'progress' || msg.type === 'done') {
    run.report = msg.report;
    if (msg.fields) {
      run.fields = msg.fields;
      pushFieldsToViewer();
    }
    const now = performance.now();
    if (now - run.lastWall > 1500) {
      const r = (msg.report.time - run.lastT) / ((now - run.lastWall) / 1000);
      run.rate = run.rate ? run.rate * 0.6 + r * 0.4 : r;
      run.lastT = msg.report.time; run.lastWall = now;
    }
  }
  if (msg.type === 'done') {
    run.state = 'done';
    const conv = msg.reason === 'converged';
    toast(conv ? `ลู่เข้าแล้วที่ t = ${msg.report.time.toFixed(0)} s` : `ถึงเพดานเวลา ${msg.report.time.toFixed(0)} s แต่ยังไม่ลู่เข้า — กดคำนวณต่อได้`, 5000);
    addComparison();
  }
  renderResults();
  updateRunUI();
}

function pushFieldsToViewer() {
  const units = unitsNow();
  const maxDis = Math.max(4, ...(units || []).map(u => u.Tdis - scene.site.ambient));
  viewer.setResults({
    mesh: run.mesh, fields: run.fields, amb: scene.site.ambient,
    dTmax: Math.max(4, Math.ceil(maxDis * 0.75)),
    vmax: run.report?.vmax || 5,
    units,
    // T ลมเข้าเฉลี่ยรายโมดูล เรียงตามโมดูลของเครื่อง → ใช้ระบายสีตัวเครื่อง
    modTin: new Map((units || []).map(u => [u.id, u.modules.map(m => m.Tin)])),
  });
  updateBandLegend();
  updateColorbar();
  if (selected()?.type === 'cdu') renderProps();
}

/** แถบสีตามเกณฑ์ T ลมเข้า: 'green' | 'yellow' | 'red' */
function band(t) {
  const b = scene.bands;
  return t <= b.green ? 'green' : t <= b.red ? 'yellow' : 'red';
}
function chip(t) { return `<i class="chip chip-${band(t)}" title="T ลมเข้า ${t.toFixed(1)} °C — ${BAND_TEXT[band(t)].short}"></i>`; }

/** ความหมายของแต่ละแถบสีตามคำแนะนำของ Daikin */
const BAND_TEXT = {
  green: { short: 'ระบายความร้อนได้', label: 'ระบายความร้อนได้ (Daikin แนะนำ)' },
  yellow: { short: 'ประสิทธิภาพลดลง', label: 'ทำงานได้ แต่ประสิทธิภาพลดลง' },
  red: { short: 'ระบายความร้อนไม่ได้', label: 'ระบายความร้อนไม่ได้ — ควรปรับการวาง' },
};

/** เกณฑ์อุณหภูมิลมกลับ (HTML) — ใช้ทั้งในหน้าผลและรายงาน */
function bandCriteriaHTML() {
  const b = scene.bands;
  return `<ul class="criteria">
    <li><i class="chip chip-green"></i>อุณหภูมิลมกลับที่ไม่เกิน ${b.green} องศาเซลเซียส คอยล์ร้อนสามารถระบายความร้อนได้ เป็นอุณหภูมิลมกลับที่ Daikin แนะนำ</li>
    <li><i class="chip chip-yellow"></i>อุณหภูมิลมกลับที่อยู่ระหว่าง ${b.green}–${b.red} องศาเซลเซียส คอยล์ร้อนสามารถทำงานได้ แต่ประสิทธิภาพการทำงานของเครื่องปรับอากาศจะลดลง</li>
    <li><i class="chip chip-red"></i>อุณหภูมิลมกลับที่เกิน ${b.red} องศาเซลเซียส คอยล์ร้อนไม่สามารถระบายความร้อนได้ ควรปรับเปลี่ยนลักษณะการวางคอยล์ร้อน</li>
  </ul>`;
}

/** หมายเหตุท้ายผล/รายงาน */
const REMARK_HTML = `<p><b>REMARK :</b></p>
  <ol>
    <li>เนื่องจากการจำลองการไหลของอากาศที่เกิดขึ้น เป็นการทดลองด้วย PROGRAM COMPUTER เท่านั้น วัตถุประสงค์เพื่อใช้ในการป้องกันหรือหาแนวทางแก้ไขปัญหาเรื่องของการระบายความร้อน ซึ่งไม่ใช่สภาวะอากาศจริงที่เกิดขึ้นกับ CDU</li>
    <li>ทั้งนี้ทิศทางลมที่เข้ามาจะขึ้นอยู่กับฤดูกาล และช่วงเวลาในขณะนั้นด้วย ซึ่งจะแตกต่างกับ CFD ที่มีอยู่เพียงทิศทางเดียว ดังนั้นควรจะทำการทดลองติดตั้ง MOCK UP ROOM เพื่อตรวจสอบ ผลที่ได้จาก CFD อีกครั้ง</li>
  </ol>
  <p lang="en">Please noted that this simulation is done on the computer system that analyses the air flow pattern. A/C equipment under simulation only applicable to DAIKIN system and is not based on any actual experiments. Therefore, the simulation does not guarantee the phenomena at the actual installation site.</p>`;

/** แถบสีของเครื่อง: ใช้โมดูลที่ T ลมเข้าสูงสุด (เหมือนสีในตาราง) */
function unitBand(u) { return band(Math.max(...u.modules.map(m => m.Tin))); }

function updateBandLegend() {
  const b = scene.bands;
  const el = $('#band-legend');
  el.hidden = !run.fields || run.stale;
  el.innerHTML = `<span class="muted">สี CDU = T ลมเข้าเฉลี่ยรายโมดูล</span>
    <span><i class="chip chip-green"></i>≤ ${b.green} °C</span>
    <span><i class="chip chip-yellow"></i>${b.green}–${b.red} °C</span>
    <span><i class="chip chip-red"></i>&gt; ${b.red} °C</span>`;
}

/** ผลรายเครื่อง (รวมโมดูล) จากรายงานล่าสุด */
function unitsNow() {
  const r = run.report, M = run.mesh;
  if (!r || !M) return null;
  const amb = scene.site.ambient;
  return M.units.map(u => {
    const ms = u.modules.map(i => ({ ...r.modules[i], idx: i })).filter(m => m.active !== false);
    if (!ms.length) return null;
    const q = ms.reduce((s, m) => s + m.q, 0);
    const avg = k => ms.reduce((s, m) => s + m[k] * m.q, 0) / q;
    const kwRated = ms.reduce((s, m) => s + m.kw, 0);
    const kwAvail = ms.reduce((s, m) => s + m.kw * m.capF, 0);
    const Tin = avg('Tin');
    const TinMax = Math.max(...ms.map(m => m.TinMax));
    const o = scene.objects.find(x => x.id === u.id);
    return {
      id: u.id, name: u.name, model: u.model, obj: o,
      kwRated, kwAvail, capF: kwAvail / kwRated, cmm: q * 60,
      Tin, TinMax, dT: Tin - amb, Cin: avg('Cin'), Tdis: avg('Tdis'),
      blockedPct: avg('blockedPct'), status: unitStatus(Tin - amb, Tin, scene.perf),
      modules: ms,
    };
  }).filter(Boolean);
}

/* ───────── การแสดงผลลัพธ์ ───────── */

function updateRunUI() {
  updatePlayButton();
  const b = $('#btn-run');
  const st = $('.status');
  const r = run.report;
  st.classList.toggle('running', run.state === 'running');
  st.classList.toggle('done', run.state === 'done');
  b.classList.toggle('running', run.state === 'running');
  if (run.state === 'running') b.textContent = '⏸ หยุด';
  else if (run.state === 'paused' && !run.stale) b.textContent = '▶ คำนวณต่อ';
  else if (run.state === 'done' && !run.stale) b.textContent = r?.converged ? '✓ ลู่เข้าแล้ว' : '▶ คำนวณต่อจนลู่เข้า';
  else b.textContent = '▶ คำนวณ';

  const t = r?.time ?? 0;
  const ck = r?.checks;
  const nPass = ck ? Object.values(ck).filter(Boolean).length : 0, nAll = ck ? Object.keys(ck).length : 4;
  let text = 'พร้อมคำนวณ';
  if (run.stale) text = 'แบบเปลี่ยน — กดคำนวณใหม่';
  else if (run.state === 'running') text = t < 0.01 ? 'กำลังเตรียมเมช…' : 'กำลังคำนวณ';
  else if (run.state === 'paused') text = 'หยุดชั่วคราว';
  else if (run.state === 'done') text = r?.converged ? 'ลู่เข้าแล้ว ✓' : 'ถึงเพดานเวลา (ยังไม่ลู่เข้า)';
  $('#st-text').textContent = text;
  // ความคืบหน้า = เกณฑ์ลู่เข้าที่ผ่าน + จำนวนครั้งที่ผ่านต่อเนื่อง
  let prog = 0;
  if (r?.converged) prog = 1;
  else if (ck) prog = (nPass / nAll) * 0.8 + (r.hold / r.conv.hold) * 0.2;
  $('#st-time').textContent = r ? `t ${t.toFixed(1)} s · เกณฑ์ ${r.converged ? nAll : nPass}/${nAll}` : 't 0.0 s';
  $('#st-bar').style.width = `${Math.min(100, prog * 100)}%`;
  if (run.state === 'running' && r) $('#estimate').textContent = isFinite(r.drift)
    ? `ΔT ลมเข้าเปลี่ยน ±${r.drift.toFixed(3)} °C (เป้า ≤ ${r.conv.drift})` : 'กำลังสะสมข้อมูลเพื่อตรวจการลู่เข้า…';
  else updateEstimate();

  const badge = $('#res-badge');
  badge.className = 'badge';
  if (run.stale) { badge.textContent = 'ผลเก่า (แบบถูกแก้ไข)'; badge.classList.add('stale'); }
  else if (run.state === 'running') { badge.textContent = 'กำลังคำนวณ — ผลเปลี่ยนแบบสด'; badge.classList.add('run'); }
  else if (run.state === 'done') { badge.textContent = r?.converged ? 'ลู่เข้าแล้ว' : 'ยังไม่ลู่เข้า (ถึงเพดานเวลา)'; badge.classList.add(r?.converged ? 'ok' : 'stale'); }
  else if (run.state === 'paused') badge.textContent = 'หยุดชั่วคราว';
  else badge.textContent = 'ยังไม่มีผล';
  $('#btn-csv').disabled = $('#btn-report').disabled = !run.report;
}

function renderResults() {
  const units = unitsNow();
  const tb = $('#res-table tbody');
  $('#res-table').classList.toggle('stale-table', run.stale);
  if (!units) {
    tb.innerHTML = `<tr><td colspan="13" class="muted">ยังไม่มีผล — กด ▶ คำนวณ</td></tr>`;
    $('#kpis').innerHTML = '';
    $('#quality').innerHTML = '';
    $('#advice').innerHTML = '<li class="muted">กด ▶ คำนวณ เพื่อดูผล</li>';
    $('#criteria').innerHTML = bandCriteriaHTML();
    drawChart(null);
    drawResiduals();
    return;
  }
  const rows = [];
  for (const u of units) {
    rows.push(`<tr data-id="${u.id}" class="${u.id === selectedId ? 'sel' : ''}">
      <td><b>${esc(u.name)}</b></td><td>${esc(u.model)}</td><td class="n">${u.kwRated.toFixed(1)}</td><td class="n">${u.cmm.toFixed(0)}</td>
      <td class="n">${chip(Math.max(...u.modules.map(m => m.Tin)))}${u.Tin.toFixed(2)}</td><td class="n">${u.TinMax.toFixed(1)}</td><td class="n st-${u.status.key}">+${u.dT.toFixed(2)}</td>
      <td class="n">${(u.Cin * 100).toFixed(1)}</td><td class="n">${u.Tdis.toFixed(1)}</td><td class="n">${(u.capF * 100).toFixed(1)}</td>
      <td class="n">${u.kwAvail.toFixed(1)}</td><td class="n">${u.blockedPct.toFixed(0)}</td>
      <td><span class="pill st-${u.status.key}">${u.status.short}</span></td></tr>`);
    if (u.modules.length > 1) for (const m of u.modules) {
      rows.push(`<tr class="sub" data-id="${u.id}"><td>โมดูล ${m.hp} HP</td><td></td><td class="n">${m.kw.toFixed(1)}</td><td class="n">${(m.q * 60).toFixed(0)}</td>
        <td class="n">${chip(m.Tin)}${m.Tin.toFixed(2)}</td><td class="n">${m.TinMax.toFixed(1)}</td><td class="n">+${(m.Tin - scene.site.ambient).toFixed(2)}</td>
        <td class="n">${(m.Cin * 100).toFixed(1)}</td><td class="n">${m.Tdis.toFixed(1)}</td><td class="n">${(m.capF * 100).toFixed(1)}</td>
        <td class="n">${(m.kw * m.capF).toFixed(1)}</td><td class="n">${m.blockedPct.toFixed(0)}</td><td></td></tr>`);
    }
  }
  tb.innerHTML = rows.join('');
  $('#criteria').innerHTML = bandCriteriaHTML();
  $$('tr', tb).forEach(tr => tr.addEventListener('click', () => select(Number(tr.dataset.id))));

  // ตัวเลขสรุป
  const worst = units.reduce((a, b) => (b.dT > a.dT ? b : a));
  const kwR = units.reduce((s, u) => s + u.kwRated, 0), kwA = units.reduce((s, u) => s + u.kwAvail, 0);
  const avgDT = units.reduce((s, u) => s + u.dT * u.cmm, 0) / units.reduce((s, u) => s + u.cmm, 0);
  const nIssue = units.filter(u => u.status.key !== 'ok').length;
  $('#kpis').innerHTML = [
    kpi('ΔT สูงสุด', `+${worst.dT.toFixed(2)} °C`, `${esc(worst.name)} · T ลมเข้า ${worst.Tin.toFixed(1)} °C`, worst.status.key),
    kpi('ΔT เฉลี่ย (ถ่วงอัตราลม)', `+${avgDT.toFixed(2)} °C`, `อากาศภายนอก ${scene.site.ambient} °C`),
    kpi('Capacity รวม', `${(kwA / kwR * 100).toFixed(1)}%`, `${kwA.toFixed(1)} จาก ${kwR.toFixed(1)} kW (หาย ${(kwR - kwA).toFixed(1)} kW)`),
    kpi('เครื่องที่ต้องดูแล', `${nIssue} / ${units.length}`, nIssue ? 'ΔT ≥ 1 °C' : 'ทุกเครื่อง ΔT < 1 °C', nIssue ? 'watch' : 'ok'),
  ].join('');

  renderQuality();
  renderAdvice(units);
  drawChart(units);
  drawResiduals();
}

function kpi(k, v, s, st) {
  return `<div class="kpi"><div class="k">${k}</div><div class="v ${st ? 'st-' + st : ''}">${v}</div><div class="s">${s}</div></div>`;
}

function renderQuality() {
  const r = run.report, M = run.mesh;
  const q = [];
  const cls = (ok) => ok ? 'good' : 'warn';
  q.push(['กริด', `${M.nx}×${M.ny}×${M.nz} · h = ${M.h} ม.`]);
  q.push(['เซลล์อากาศ / louver', `${fmtK(M.stats.fluid)} / ${fmtK(M.stats.porous)}`]);
  q.push(['เวลาจำลอง · สเต็ป', `${r.time.toFixed(1)} s · ${r.steps}`]);
  q.push(['Δt', `${(r.dt * 1000).toFixed(0)} ms`]);
  q.push(['รอบ Poisson ต่อสเต็ป', `${r.pIters}`]);
  // เกณฑ์ลู่เข้า — ต้องผ่านทุกข้อต่อเนื่องกัน
  const C = r.conv, ck = r.checks || {};
  const mark = (ok) => ok ? '✓ ' : '✗ ';
  const bal = r.balance.ratio;
  q.push(['<b>เกณฑ์ลู่เข้า</b>', r.converged ? '<b>ผ่านครบ ✓</b>' : `ผ่านต่อเนื่อง ${r.hold}/${C.hold} ครั้ง`, r.converged ? 'good' : '']);
  q.push([`${mark(ck.time)}เวลาจำลอง ≥ ${C.tMin} s`, `${r.time.toFixed(1)} s`, cls(ck.time)]);
  q.push([`${mark(ck.drift)}T ลมเข้าเปลี่ยน ≤ ±${C.drift} °C`, isFinite(r.drift) ? `±${r.drift.toFixed(3)} °C` : 'รอข้อมูล 20 s', cls(ck.drift)]);
  q.push([`${mark(ck.balance)}สมดุลพลังงาน ${C.balLo * 100}–${C.balHi * 100}%`, isFinite(bal) ? `${(bal * 100).toFixed(1)}%` : '–', cls(ck.balance)]);
  q.push([`${mark(ck.mass)}ความคลาดเคลื่อนมวล ≤ ${C.mass * 100}%`, `${(r.divErr * 100).toFixed(2)}%`, cls(ck.mass)]);
  q.push(['ความร้อนจาก CDU', `${(r.balance.qIn / 1000).toFixed(1)} kW`]);
  const bcName = { open: 'เปิด', wall: 'ผนัง', symmetry: 'สมมาตร' };
  q.push(['ขอบ X− / X+ / Z− / Z+ / บน', ['xmin', 'xmax', 'zmin', 'zmax', 'ymax'].map(f => bcName[M.bc[f].type]).join(' / ')]);
  const fa = M.modules.filter(m => m.active);
  const ratio = fa.reduce((s, m) => s + m.fanAreaGrid, 0) / Math.max(1e-6, fa.reduce((s, m) => s + m.fanAreaReal, 0));
  q.push(['พื้นที่พัดลมบนกริด / จริง', `${(ratio * 100).toFixed(0)}%`, cls(ratio > 0.6 && ratio < 1.6)]);
  q.push(['ค่าเฉลี่ยผลช่วงสุดท้าย', `${r.avgWindow.toFixed(0)} s`]);
  if (run.rate) q.push(['ความเร็วคำนวณ', `${run.rate.toFixed(2)} s จำลอง / วินาที`]);
  $('#quality').innerHTML = q.map(([k, v, c]) => `<div class="q">${k}</div><div class="v ${c || ''}">${v}</div>`).join('');
}

function renderAdvice(units) {
  const out = [];
  const perf = scene.perf;
  const walls = scene.objects.filter(o => o.type === 'wall');
  for (const u of units) {
    const o = u.obj;
    if (!o) continue;
    if (u.status.key === 'ok') continue;
    const top = (o.elev || 0) + unitSize(o).h + (o.duct || 0);
    const tips = [];
    if (u.TinMax >= perf.Tlimit || u.Tin >= perf.Tlimit) tips.push(`<b>เสี่ยงตัดการทำงาน</b> — จุดร้อนหน้าคอยล์ ${u.TinMax.toFixed(1)} °C ถึงขีดจำกัด ${perf.Tlimit} °C`);
    const near = walls.filter(w => distToSeg(o.x, o.z, w) < 4);
    const tall = near.filter(w => (w.gap || 0) + w.height > top - 0.1);
    if (!(o.duct > 0) && (tall.length || u.Cin > 0.1)) tips.push(`ติดท่อเป่าลมให้ปากลมสูงกว่า${tall.length ? 'ผนังรอบข้าง' : 'เดิม'} ≥ 0.5–1 ม.`);
    const lowLouver = near.filter(w => w.louver > 0 && w.louver < 60);
    if (lowLouver.length) tips.push(`เพิ่มพื้นที่เปิดของ ${lowLouver.map(w => esc(w.name)).join(', ')} (ตอนนี้ ${lowLouver.map(w => w.louver + '%').join(', ')})`);
    const solidNear = near.filter(w => !(w.louver > 0));
    if (solidNear.length) tips.push(`ผนังทึบใกล้เครื่อง (${solidNear.map(w => esc(w.name)).join(', ')}) — เปลี่ยนเป็น louver หรือเว้นระยะมากขึ้น`);
    if (u.blockedPct > 20) tips.push(`หน้าคอยล์ถูกบัง ${u.blockedPct.toFixed(0)}% — เพิ่มระยะจากผนัง/เครื่องข้างเคียง`);
    if (!tips.length) tips.push('ขยับให้ห่างจากเครื่องที่อยู่ต้นลม หรือเพิ่มระยะระหว่างแถว');
    out.push(`<li><b class="st-${u.status.key}">${esc(u.name)}</b> ΔT +${u.dT.toFixed(2)} °C · ลมวนกลับ ${(u.Cin * 100).toFixed(1)}% · capacity ${(u.capF * 100).toFixed(1)}%
      <br>${tips.map(t => '→ ' + t).join('<br>')}</li>`);
  }
  if (!out.length) out.push('<li><b class="st-ok">ทุกเครื่อง ΔT &lt; 1 °C</b> — ลมร้อนวนกลับน้อย ผังนี้ใช้ได้ในเงื่อนไขที่ตั้งไว้</li>');
  const r = run.report;
  if (run.mesh.h >= 0.45) out.push('<li class="muted">ผลจากเมชหยาบ (0.5 ม.) ใช้ร่างผังเท่านั้น — ยืนยันด้วยเซลล์ 0.25–0.35 ม.</li>');
  if (run.state === 'done' && !r.converged) out.push('<li class="muted">ถึงเพดานเวลาแต่ยังไม่ลู่เข้า — กด "คำนวณต่อจนลู่เข้า" หรือเพิ่มเพดานเวลาในหัวข้อขั้นสูง</li>');
  if (!(scene.site.windSpeed > 0)) out.push('<li class="muted">คำนวณแบบไม่มีลม (มักเป็นกรณีแย่ที่สุด) — ลองใส่ลม 1–3 m/s จากทิศที่พบบ่อยเพื่อเทียบ</li>');
  $('#advice').innerHTML = out.join('');
}

function renderWarnings(ws) {
  if (ws && ws.length) toast(ws.slice(0, 3).join(' · '), 6000);
}

/* กราฟ T ลมเข้าตามเวลา */
const PALETTE = ['#4fc3f7', '#f2c14e', '#ef6f6c', '#7bd389', '#b692f6', '#f59e42', '#5eead4', '#f472b6', '#a3e635', '#93c5fd', '#fca5a5', '#fde68a'];

function drawChart(units) {
  const cv = $('#chart');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 220;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  const r = run.report;
  if (!units || !r || !r.history.t.length) {
    x.fillStyle = '#5c7385'; x.font = '13px sans-serif';
    x.fillText('กราฟจะแสดงระหว่างคำนวณ', 14, 26);
    $('#chart-note').textContent = '';
    return;
  }
  const t = r.history.t, amb = scene.site.ambient;
  const series = units.map((u, i) => {
    const q = u.modules.reduce((s, m) => s + m.q, 0);
    const ys = t.map((_, a) => u.modules.reduce((s, m) => s + r.history.tin[m.idx][a] * m.q, 0) / q);
    return { name: u.name, color: PALETTE[i % PALETTE.length], ys };
  });
  let lo = amb, hi = amb + 1;
  for (const s of series) for (const y of s.ys) { if (y > hi) hi = y; if (y < lo) lo = y; }
  hi = Math.ceil((hi + 0.2) * 2) / 2; lo = Math.floor(lo * 2) / 2;
  const pl = 42, pr = 10, pt = 10, pb = 44;
  const X = v => pl + (v - t[0]) / Math.max(1e-6, t[t.length - 1] - t[0]) * (W - pl - pr);
  const Y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  x.strokeStyle = '#243a4c'; x.fillStyle = '#86a0b3'; x.font = '11px "IBM Plex Mono", monospace'; x.lineWidth = 1;
  const stepY = (hi - lo) > 6 ? 2 : (hi - lo) > 2.5 ? 1 : 0.5;
  for (let v = lo; v <= hi + 1e-6; v += stepY) {
    x.beginPath(); x.moveTo(pl, Y(v)); x.lineTo(W - pr, Y(v)); x.stroke();
    x.fillText(v.toFixed(1), 4, Y(v) + 4);
  }
  const t0 = t[0], t1 = t[t.length - 1], stepX = t1 - t0 > 400 ? 120 : t1 - t0 > 120 ? 30 : t1 - t0 > 40 ? 10 : 5;
  for (let v = Math.ceil(t0 / stepX) * stepX; v <= t1; v += stepX) x.fillText(`${v}s`, X(v) - 8, H - pb + 14);
  // เส้นอากาศภายนอก
  x.setLineDash([4, 4]); x.strokeStyle = '#86a0b3';
  x.beginPath(); x.moveTo(pl, Y(amb)); x.lineTo(W - pr, Y(amb)); x.stroke(); x.setLineDash([]);
  for (const s of series) {
    x.strokeStyle = s.color; x.lineWidth = 1.6; x.beginPath();
    s.ys.forEach((y, a) => (a ? x.lineTo(X(t[a]), Y(y)) : x.moveTo(X(t[a]), Y(y))));
    x.stroke();
  }
  // คำอธิบายสี
  let lx = pl, ly = H - 12;
  x.font = '11.5px sans-serif';
  for (const s of series) {
    const w = x.measureText(s.name).width + 22;
    if (lx + w > W - 4) { lx = pl; ly -= 0; }
    x.fillStyle = s.color; x.fillRect(lx, ly - 8, 12, 3);
    x.fillStyle = '#b9ccd9'; x.fillText(s.name, lx + 16, ly - 3);
    lx += w;
  }
  $('#chart-note').textContent = `เส้นประ = อากาศภายนอก ${amb} °C`;
}

/* กราฟ residual (สเกล log) แบบ CFX */
function drawResiduals() {
  const cv = $('#chart-res');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 220;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  const r = run.report;
  const h = r?.history;
  if (!h || h.t.length < 2) {
    x.fillStyle = '#5c7385'; x.font = '13px sans-serif';
    x.fillText('กราฟ residual จะแสดงระหว่างคำนวณ', 14, 26);
    return;
  }
  const series = [
    { name: 'มวล (continuity)', color: '#4fc3f7', ys: h.res.mass },
    { name: 'โมเมนตัม', color: '#f2c14e', ys: h.res.mom },
    { name: 'พลังงาน', color: '#ef6f6c', ys: h.res.energy },
  ];
  const lo = -8, hi = 0;   // log10
  const pl = 42, pr = 10, pt = 10, pb = 44;
  const t = h.t;
  const X = v => pl + (v - t[0]) / Math.max(1e-6, t[t.length - 1] - t[0]) * (W - pl - pr);
  const Y = v => pt + (1 - (Math.log10(Math.max(1e-8, v)) - lo) / (hi - lo)) * (H - pt - pb);
  x.strokeStyle = '#243a4c'; x.fillStyle = '#86a0b3'; x.font = '11px "IBM Plex Mono", monospace'; x.lineWidth = 1;
  for (let e = lo; e <= hi; e += 2) {
    const y = Y(10 ** e);
    x.beginPath(); x.moveTo(pl, y); x.lineTo(W - pr, y); x.stroke();
    x.fillText(`1e${e}`, 4, y + 4);
  }
  const t1 = t[t.length - 1], stepX = t1 - t[0] > 400 ? 120 : t1 - t[0] > 120 ? 30 : 10;
  for (let v = Math.ceil(t[0] / stepX) * stepX; v <= t1; v += stepX) x.fillText(`${v}s`, X(v) - 8, H - pb + 14);
  for (const s of series) {
    x.strokeStyle = s.color; x.lineWidth = 1.5; x.beginPath();
    s.ys.forEach((y, a) => (a ? x.lineTo(X(t[a]), Y(y)) : x.moveTo(X(t[a]), Y(y))));
    x.stroke();
  }
  let lx = pl;
  x.font = '11.5px sans-serif';
  for (const s of series) {
    x.fillStyle = s.color; x.fillRect(lx, H - 20, 12, 3);
    x.fillStyle = '#b9ccd9'; x.fillText(s.name, lx + 16, H - 15);
    lx += x.measureText(s.name).width + 30;
  }
}

/* เปรียบเทียบทางเลือก */
function addComparison() {
  const units = unitsNow();
  if (!units?.length) return;
  const kwR = units.reduce((s, u) => s + u.kwRated, 0), kwA = units.reduce((s, u) => s + u.kwAvail, 0);
  compare.push({
    name: scene.name, h: run.mesh.h, time: run.report.time, converged: run.report.converged,
    maxDT: Math.max(...units.map(u => u.dT)),
    avgDT: units.reduce((s, u) => s + u.dT * u.cmm, 0) / units.reduce((s, u) => s + u.cmm, 0),
    cap: kwA / kwR, sceneJSON: run.sceneJSON,
  });
  renderCompare();
}

function renderCompare() {
  const tb = $('#cmp-table tbody');
  if (!compare.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">ยังไม่มี</td></tr>'; return; }
  tb.innerHTML = compare.map((c, i) => `<tr>
    <td>${i + 1}. ${esc(c.name)}${c.converged ? '' : ' <span class="muted small">(ยังไม่นิ่ง)</span>'}</td>
    <td class="n">${c.h}</td><td class="n">+${c.maxDT.toFixed(2)}</td><td class="n">+${c.avgDT.toFixed(2)}</td>
    <td class="n">${(c.cap * 100).toFixed(1)}%</td><td><button data-i="${i}" title="เปิดแบบของทางเลือกนี้">เปิด</button></td></tr>`).join('');
  $$('button', tb).forEach(b => b.addEventListener('click', () => {
    const c = compare[Number(b.dataset.i)];
    edit(() => { scene = normalizeScene(JSON.parse(c.sceneJSON)); });
    toast(`เปิดแบบ "${c.name}" — กดคำนวณเพื่อดูผลอีกครั้ง`);
  }));
}

/* ───────── ระนาบหน้าตัด / แถบสี / หัววัด ───────── */

function syncSectionUI(pos) {
  const s = viewer.section;
  if (pos != null) s.pos = pos;
  const [a, b] = viewer.sectionLimits();
  $('#d-pos').value = (s.pos - a) / Math.max(1e-6, b - a);
  $('#d-pos-val').textContent = `${s.axis} = ${s.pos.toFixed(2)} ม.`;
  $$('#d-axis button').forEach(btn => btn.classList.toggle('on', btn.dataset.v === s.axis));
  const name = s.axis === 'y' ? `ระนาบนอน ที่ความสูง y = ${s.pos.toFixed(2)} m` : `หน้าตัดตั้งฉากแกน ${s.axis.toUpperCase()} ที่ ${s.axis} = ${s.pos.toFixed(2)} m`;
  $('#sec-info').textContent = name;
}

function updatePlayButton(on = viewer.display.playing) {
  const b = $('#btn-play');
  b.disabled = !run.fields || run.stale;
  b.classList.toggle('on', on);
  b.textContent = on ? '❚❚ หยุดภาพเคลื่อนไหว' : '▶ เล่นภาพเคลื่อนไหว';
}

/** ตัวเลขบนแถบสี [{p: 0–1, txt}] — null ถ้ายังไม่มีผล */
function colorbarTicks() {
  const f = viewer.display.field;
  const rng = viewer.fieldRange();
  if (!rng) return null;
  const meta = FIELDS[f];
  const [lo, hi] = rng;
  const n = 4;
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = lo + (hi - lo) * i / (n - 1);
    let txt = `${v.toFixed(meta.digits)}${meta.unit === '%' ? '%' : ''}`;
    if (i === 0 && f === 'T') txt = `${v.toFixed(1)} °C ambient`;
    else if (f === 'P' && i < n - 1) txt = `${v >= 0 ? '+' : ''}${v.toFixed(meta.digits)}`;
    else if (i === n - 1) txt += meta.unit === '%' ? '+' : ` ${meta.unit}`;
    out.push({ p: i / (n - 1), txt });
  }
  return out;
}

function updateColorbar() {
  updatePlayButton();
  $('#cbar').style.background = cssGradient(viewer.display.mode === 'contour' ? CONTOUR_LEVELS : 0);
  const lab = $('#cbar-labels');
  const ticks = colorbarTicks();
  if (!ticks) {
    lab.innerHTML = `<span style="left:0">${scene.site.ambient} °C (ambient)</span><span style="left:100%">คำนวณเพื่อดูสเกล</span>`;
    return;
  }
  lab.innerHTML = ticks.map(t => `<span style="left:${t.p * 100}%">${t.txt}</span>`).join('');
}

/* ───────── Capture ภาพหลายมุมสำหรับรายงาน ───────── */

const captures = [];   // { url, caption }
const VIEW_NAME = { '3d': 'มุมมอง 3D', n: '3D จากทิศเหนือ', s: '3D จากทิศใต้', e: '3D จากทิศตะวันออก', w: '3D จากทิศตะวันตก', top: 'มุมมองด้านบน (Top)', px: 'มุมมอง +X', nx: 'มุมมอง −X', py: 'มุมมองด้านบน (Top)', ny: 'มุมมอง −Y (ล่าง)', pz: 'มุมมอง +Z', nz: 'มุมมอง −Z' };
const MODE_NAME = { contour: 'Contour', stream: 'Streamline', vector: 'Vector' };

/** ภาพจากมุมมองปัจจุบัน + หัวเรื่องและแถบสี วาดรวมเป็น PNG เดียว */
async function composeCapture(caption) {
  const src = new Image();
  src.src = viewer.snapshot();
  await src.decode();
  const W = src.width, s = W / 1200;
  const head = Math.round(34 * s), foot = Math.round(70 * s);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = src.height + head + foot;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(src, 0, head);
  g.fillStyle = '#1c2a36';
  g.font = `600 ${Math.round(17 * s)}px "IBM Plex Sans Thai", Tahoma, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(caption, 12 * s, head / 2);
  const ticks = colorbarTicks();
  if (ticks) {
    const x0 = 16 * s, x1 = Math.min(W - 16 * s, x0 + 620 * s), y = head + src.height + 14 * s, bh = 16 * s;
    const lv = viewer.display.mode === 'contour' ? CONTOUR_LEVELS : 0;
    const N = 240;
    for (let i = 0; i < N; i++) {
      let t = i / (N - 1);
      if (lv) t = (Math.min(lv - 1, Math.floor(t * lv)) + 0.5) / lv;
      const c = rgb(t);
      g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      g.fillRect(x0 + (x1 - x0) * i / N, y, (x1 - x0) / N + 1, bh);
    }
    g.strokeStyle = '#8a98a5'; g.lineWidth = Math.max(1, s); g.strokeRect(x0, y, x1 - x0, bh);
    g.fillStyle = '#1c2a36';
    g.font = `${Math.round(13 * s)}px "IBM Plex Sans Thai", Tahoma, sans-serif`;
    g.textBaseline = 'top';
    ticks.forEach((t, i) => {
      g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center';
      g.fillText(t.txt, x0 + (x1 - x0) * t.p, y + bh + 5 * s);
    });
    g.textAlign = 'left';
    g.fillText(`${FIELDS[viewer.display.field].label} · ${MODE_NAME[viewer.display.mode]}`, x1 + 16 * s, y);
  }
  return cv.toDataURL('image/png');
}

function captionNow() {
  const f = FIELDS[viewer.display.field];
  const sec = viewer.section.show ? ` · หน้าตัด ${viewer.section.axis.toUpperCase()} = ${viewer.section.pos.toFixed(2)} ม.` : '';
  return `${scene.name} — ${VIEW_NAME[viewer.view] || viewer.view}${run.fields ? ` · ${f.label}${sec}` : ''}`;
}

async function captureView() {
  const url = await composeCapture(captionNow());
  captures.push({ url, caption: captionNow() });
  const fl = document.createElement('div');
  fl.className = 'capture-flash';
  $('#viewport').appendChild(fl);
  requestAnimationFrame(() => { fl.style.opacity = '0'; setTimeout(() => fl.remove(), 400); });
  renderCaptures();
  toast(`บันทึกภาพที่ ${captures.length} แล้ว — อยู่ในรายงาน HTML`);
}

function renderCaptures() {
  $('#cap-count').textContent = `(${captures.length})`;
  $('#btn-cap-all').disabled = $('#btn-cap-clear').disabled = !captures.length;
  const box = $('#cap-list');
  if (!captures.length) {
    box.innerHTML = `<p class="muted small" style="margin:0">กด <b>📷 Capture</b> บนภาพ 3D เพื่อเก็บภาพหลายมุม (หมุน/เลือกแกน/เลื่อนหน้าตัดก่อนกด)
      — ทุกภาพจะอยู่ในรายงาน HTML ตามลำดับ แก้คำบรรยายใต้ภาพได้</p>`;
    return;
  }
  box.innerHTML = captures.map((c, i) => `<div class="cap-item" data-i="${i}">
    <img src="${c.url}" alt="ภาพที่ ${i + 1}" title="คลิกเพื่อเปิดภาพเต็ม">
    <input type="text" value="${esc(c.caption)}" title="คำบรรยายใต้ภาพในรายงาน">
    <div class="cap-row"><span class="muted">ภาพที่ ${i + 1}</span><span>
      <button class="ghost" data-a="up" ${i ? '' : 'disabled'} title="เลื่อนขึ้น">↑</button>
      <button class="ghost" data-a="dl" title="ดาวน์โหลด PNG">⬇</button>
      <button class="ghost danger" data-a="del" title="ลบ">✕</button></span></div></div>`).join('');
  $$('.cap-item', box).forEach(el => {
    const i = Number(el.dataset.i);
    $('input', el).addEventListener('change', (e) => { captures[i].caption = e.target.value; });
    $('img', el).addEventListener('click', () => { const w = window.open(); if (w) w.document.write(`<img src="${captures[i].url}" style="max-width:100%">`); });
    $('[data-a="dl"]', el).addEventListener('click', () => downloadURL(captures[i].url, `${safeName(scene.name)}-${i + 1}.png`));
    $('[data-a="del"]', el).addEventListener('click', () => { captures.splice(i, 1); renderCaptures(); });
    $('[data-a="up"]', el).addEventListener('click', () => { [captures[i - 1], captures[i]] = [captures[i], captures[i - 1]]; renderCaptures(); });
  });
}

function downloadURL(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

function setViewUI(v) {
  viewer.setView(v);
  $$('.vt').forEach(x => x.classList.toggle('on', x.dataset.view === viewer.view));
}

/** เต็มจอทั้งพื้นที่ทำงาน (แถบเครื่องมือ + ภาพ + แผงแก้วัตถุ) เพื่อให้แก้โมเดลต่อได้ */
function toggleFullscreen() {
  const ws = $('#workspace');
  if (document.fullscreenElement) document.exitFullscreen?.();
  else ws.requestFullscreen?.().catch(() => toast('เบราว์เซอร์ไม่อนุญาตโหมดเต็มจอ'));
}

function showProbe(info) {
  const el = $('#probe');
  if (!info) { el.textContent = 'จุดบนระนาบ: –'; return; }
  const p = info.p;
  const at = `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
  if (info.solid) { el.textContent = `จุดบนระนาบ ${at}: ของแข็ง`; return; }
  const P = info.P == null ? '' : ` · P ${info.P >= 0 ? '+' : ''}${info.P.toFixed(2)} Pa`;
  el.textContent = `จุดบนระนาบ ${at}: T ${info.T.toFixed(2)} °C · ΔT +${(info.T - scene.site.ambient).toFixed(2)} °C · |V| ${info.V.toFixed(2)} m/s${P} · ลมจาก CDU ${(info.C * 100).toFixed(0)}%`;
}

/* ───────── ไฟล์ / ส่งออก ───────── */

function saveProject() {
  download(`${safeName(scene.name)}.json`, JSON.stringify(scene, null, 2), 'application/json');
}

function openProject(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const s = normalizeScene(JSON.parse(rd.result));
      edit(() => { scene = s; selectedId = null; });
      viewer.setView(viewer.view);
      initSection();
      toast(`เปิด "${s.name}" แล้ว`);
    } catch (e) { toast('เปิดไฟล์ไม่ได้: ' + e.message); }
  };
  rd.readAsText(file);
}

function exportCSV() {
  const units = unitsNow();
  if (!units) return;
  const head = ['CDU', 'รุ่น', 'kW พิกัด', 'อัตราลม m3/min', 'T ลมเข้าเฉลี่ย C', 'T ลมเข้าสูงสุด C', 'dT C', 'ลมวนกลับ %', 'T ลมเป่า C', 'Capacity %', 'kW ที่ได้', 'คอยล์ถูกบัง %', 'สถานะ', 'เกณฑ์ T ลมกลับ'];
  const rows = units.map(u => [u.name, u.model, u.kwRated.toFixed(1), u.cmm.toFixed(0), u.Tin.toFixed(2), u.TinMax.toFixed(2), u.dT.toFixed(2),
    (u.Cin * 100).toFixed(1), u.Tdis.toFixed(1), (u.capF * 100).toFixed(1), u.kwAvail.toFixed(1), u.blockedPct.toFixed(0), u.status.label, BAND_TEXT[unitBand(u)].label]);
  const csv = '﻿' + [head, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`${safeName(scene.name)}-results.csv`, csv, 'text/csv');
}

function exportReport() {
  const units = unitsNow();
  if (!units) return;
  const shots = captures.length ? captures : [{ url: viewer.snapshot(), caption: 'ภาพ 3 มิติ' }];
  const r = run.report;
  const date = new Date().toLocaleString('th-TH');
  const css = `body{font-family:"IBM Plex Sans Thai",Tahoma,sans-serif;color:#1c2a36;max-width:1000px;margin:24px auto;padding:0 18px}
    h1{margin:0}table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0}th,td{border:1px solid #c8d3dc;padding:5px 7px;text-align:left}
    td.n{text-align:right;font-family:monospace}th{background:#eef3f7}img{width:100%;border:1px solid #c8d3dc;border-radius:6px}figure{margin:14px 0;page-break-inside:avoid}figcaption{font-size:13px;color:#4a5d6c;margin-top:4px}
    .muted{color:#667a8a}.criteria{list-style:none;padding-left:0}.criteria li{margin:4px 0}
    .chip{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
    .chip-green{background:#3ecf6e}.chip-yellow{background:#f5c518}.chip-red{background:#e5433b}
    .remark{border-top:1px solid #c8d3dc;margin-top:22px;padding-top:8px;font-size:13px}.ok{color:#1c8a55}.watch{color:#b8860b}.bad{color:#c8551b}.trip{color:#c21d2d}ul{padding-left:18px}`;
  const tbl = units.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.model)}</td><td class="n">${u.kwRated.toFixed(1)}</td><td class="n">${u.cmm.toFixed(0)}</td>
    <td class="n">${u.Tin.toFixed(2)}</td><td class="n">${u.TinMax.toFixed(1)}</td><td class="n">+${u.dT.toFixed(2)}</td><td class="n">${(u.Cin * 100).toFixed(1)}</td>
    <td class="n">${(u.capF * 100).toFixed(1)}</td><td class="n">${u.kwAvail.toFixed(1)}</td><td class="${u.status.key}">${u.status.label}</td>
    <td><i class="chip chip-${unitBand(u)}"></i>${BAND_TEXT[unitBand(u)].label}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>${esc(scene.name)} — CDU Airflow CFD</title><style>${css}</style></head><body>
    <h1>${esc(scene.name)}</h1><p class="muted">รายงานจาก CDU Airflow CFD · ${date}</p>
    <p>อากาศภายนอก ${scene.site.ambient} °C · ลม ${scene.site.windSpeed} m/s จากทิศ ${scene.site.windDir}° · เซลล์ ${run.mesh.h} ม.
      (${run.mesh.nx}×${run.mesh.ny}×${run.mesh.nz}) · เวลาจำลอง ${r.time.toFixed(0)} s · ${r.converged ? 'ลู่เข้าแล้ว' : 'ยังไม่ลู่เข้า'}
      · สมดุลพลังงาน ${(r.balance.ratio * 100).toFixed(1)}%</p>
    ${shots.map((c, i) => `<figure><img src="${c.url}" alt="${esc(c.caption)}"><figcaption>รูปที่ ${i + 1} — ${esc(c.caption)}</figcaption></figure>`).join('')}
    <h2>ผลรายเครื่อง</h2>
    <table><tr><th>CDU</th><th>รุ่น</th><th>kW พิกัด</th><th>ลม m³/min</th><th>T ลมเข้า °C</th><th>สูงสุด °C</th><th>ΔT °C</th><th>ลมวนกลับ %</th><th>Capacity %</th><th>kW ที่ได้</th><th>สถานะ</th><th>เกณฑ์ T ลมกลับ</th></tr>${tbl}</table>
    <h2>เกณฑ์อุณหภูมิลมกลับ</h2>${bandCriteriaHTML()}
    <h2>ข้อสังเกต</h2><ul>${$('#advice').innerHTML}</ul>
    <p class="muted">ค่าเฉลี่ยตามเวลาในช่วง ${r.avgWindow.toFixed(0)} วินาทีสุดท้าย · ตัวเลขสมรรถนะเป็นค่าอ้างอิงโดยประมาณ ใช้เพื่อเปรียบเทียบผังการวางเครื่อง</p>
    <div class="remark">${REMARK_HTML}</div>
    </body></html>`;
  download(`${safeName(scene.name)}-report.html`, html, 'text/html');
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function saveAutosave() {
  try { localStorage.setItem(AUTOSAVE, JSON.stringify(scene)); } catch { /* ไม่มีพื้นที่ หรือถูกบล็อก */ }
}

function loadAutosave() {
  try {
    const s = localStorage.getItem(AUTOSAVE);
    return s ? normalizeScene(JSON.parse(s)) : null;
  } catch { return null; }
}

/* ───────── เบ็ดเตล็ด ───────── */

let toastTimer = 0;
function toast(text, ms = 3200) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function fmt(v) { return String(Math.round(v * 100) / 100); }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function fmtK(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
function fmtDur(s) {
  if (!isFinite(s)) return '–';
  if (s < 60) return `${Math.max(1, Math.round(s))} วินาที`;
  const tot = Math.round(s), m = Math.floor(tot / 60), r = tot % 60;
  return m >= 60 ? `${Math.floor(m / 60)} ชม. ${m % 60} นาที` : `${m}:${String(r).padStart(2, '0')} นาที`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function safeName(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'project'; }
function distToSeg(x, z, w) {
  const dx = w.x2 - w.x1, dz = w.z2 - w.z1, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - w.x1) * dx + (z - w.z1) * dz) / L2));
  return Math.hypot(x - (w.x1 + t * dx), z - (w.z1 + t * dz));
}

function initSection() {
  const cdus = scene.objects.filter(o => o.type === 'cdu');
  const d = domainOf(scene);
  const x = cdus.length ? cdus.reduce((s, o) => s + o.x, 0) / cdus.length : d.ox + d.W / 2;
  // วางระนาบผ่านเครื่องที่ใกล้ค่าเฉลี่ยที่สุด จะได้เห็นลำลมร้อนทันที
  const near = cdus.length ? cdus.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a)).x : x;
  viewer.setSection(viewer.section.axis, near, $('#d-section').checked);
  syncSectionUI();
}

/* ───────── เชื่อมเหตุการณ์ ───────── */

function bindUI() {
  $$('.tab').forEach(b => b.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('on', x === b));
    $('#tab-tool').hidden = b.dataset.tab !== 'tool';
    $('#tab-readme').hidden = b.dataset.tab !== 'readme';
    if (b.dataset.tab === 'tool') { viewer.resize(); drawChart(unitsNow()); drawResiduals(); }
  }));
  $$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-capture').addEventListener('click', captureView);
  $('#btn-full').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    $('#btn-full').textContent = fs ? '✕ ออกเต็มจอ' : '⛶ เต็มจอ';
    // toast ต้องอยู่ใน element ที่เต็มจอ ไม่เช่นนั้นจะมองไม่เห็น
    (fs || document.body).appendChild($('#toast'));
    setTimeout(() => viewer.resize(), 60);
  });
  $('#btn-cap-all').addEventListener('click', () => captures.forEach((c, i) =>
    setTimeout(() => downloadURL(c.url, `${safeName(scene.name)}-${i + 1}.png`), i * 250)));
  $('#btn-cap-clear').addEventListener('click', () => {
    if (confirm(`ลบภาพที่บันทึกไว้ทั้งหมด ${captures.length} ภาพ?`)) { captures.length = 0; renderCaptures(); }
  });
  $$('.vt').forEach(b => b.addEventListener('click', () => setViewUI(b.dataset.view)));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-ortho').addEventListener('click', () => setOrtho(!ortho));
  $('#btn-keys').addEventListener('click', () => toggleKeys());
  $('#keys-pop .keys-x').addEventListener('click', () => toggleKeys(false));
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-run').addEventListener('click', startOrToggle);
  $('#btn-reset').addEventListener('click', resetResults);
  $('#btn-save').addEventListener('click', saveProject);
  $('#btn-open').addEventListener('click', () => $('#file-open').click());
  $('#file-open').addEventListener('change', (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; });
  $('#btn-new').addEventListener('click', () => {
    if (scene.objects.length && !confirm('เริ่มโปรเจกต์ใหม่? (แบบปัจจุบันยังเลิกทำกลับได้ด้วย Ctrl+Z)')) return;
    edit(() => { scene = newScene(); selectedId = null; });
    resetResults();
  });
  const ps = $('#preset');
  for (const p of PRESETS) ps.insertAdjacentHTML('beforeend', `<option value="${p.key}">${esc(p.label)}</option>`);
  ps.addEventListener('change', () => {
    if (!ps.value) return;
    const key = ps.value;
    ps.value = '';
    edit(() => { scene = presetScene(key); selectedId = null; });
    resetResults();
    viewer.setView(viewer.view);
    initSection();
  });
  $('#btn-csv').addEventListener('click', exportCSV);
  $('#btn-report').addEventListener('click', exportReport);
  $('#btn-png').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = viewer.snapshot(); a.download = `${safeName(scene.name)}-3d.png`; a.click();
  });

  // การแสดงผล
  $('#d-field').addEventListener('change', (e) => { viewer.setDisplay({ field: e.target.value }); updateColorbar(); });
  $$('#d-mode button').forEach(b => b.addEventListener('click', () => {
    $$('#d-mode button').forEach(x => x.classList.toggle('on', x === b));
    viewer.setDisplay({ mode: b.dataset.v });
    // เปลี่ยนรูปแบบกราฟิก → แสดงระนาบหน้าตัดด้วย ไม่เช่นนั้นจะไม่เห็นผล
    if (!$('#d-section').checked) { $('#d-section').checked = true; viewer.setSection(viewer.section.axis, viewer.section.pos, true); }
    updateColorbar();
  }));
  const setOpacity = (v) => {
    $('#d-opacity').value = v;
    $('#d-opacity-val').textContent = `${v >= 0.999 ? 'ทึบ' : 'โปร่ง'} ${Math.round(v * 100)}%`;
    viewer.setDisplay({ objOpacity: v });
  };
  $('#d-opacity').addEventListener('input', (e) => setOpacity(parseFloat(e.target.value)));
  $$('.opacity-row .mini').forEach(b => b.addEventListener('click', () => setOpacity(parseFloat(b.dataset.op))));
  $('#btn-play').addEventListener('click', () => updatePlayButton(viewer.togglePlay()));
  $$('#d-axis button').forEach(b => b.addEventListener('click', () => {
    const d = domainOf(scene), ax = b.dataset.v;
    const mid = ax === 'x' ? d.ox + d.W / 2 : ax === 'z' ? d.oz + d.D / 2 : 1.2;
    viewer.setSection(ax, mid, $('#d-section').checked);
    syncSectionUI();
  }));
  $('#d-pos').addEventListener('input', (e) => {
    const [a, b] = viewer.sectionLimits();
    viewer.setSection(viewer.section.axis, a + (b - a) * parseFloat(e.target.value), $('#d-section').checked);
    syncSectionUI();
  });
  $('#d-section').addEventListener('change', (e) => viewer.setSection(viewer.section.axis, viewer.section.pos, e.target.checked));
  $('#d-particles').addEventListener('change', (e) => viewer.setDisplay({ particles: e.target.checked }));
  $('#d-iso').addEventListener('change', (e) => viewer.setDisplay({ iso: e.target.checked }));
  $('#d-labels').addEventListener('change', (e) => viewer.setDisplay({ labels: e.target.checked }));
  $('#d-iso-dt').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    $('#d-iso-val').textContent = `${v.toFixed(1)} °C`;
    viewer.setDisplay({ isoDT: v });
  });

  bindSettings();
  bindBands();

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    // ใช้ปุ่มจริงบนคีย์บอร์ด (e.code) ให้คีย์ลัดทำงานแม้เปิดแป้นพิมพ์ภาษาไทยอยู่
    const c = e.code || '';
    const k = c.startsWith('Key') ? c.slice(3).toLowerCase()
      : /^(Digit|Numpad)\d$/.test(c) ? c.slice(-1)
      : c === 'Period' || c === 'NumpadDecimal' ? '.'
      : c === 'Slash' && e.shiftKey ? '?'
      : c === 'Minus' || c === 'NumpadSubtract' ? '-'
      : e.key.toLowerCase();
    // ระหว่างลากผนัง: พิมพ์ตัวเลขความยาวแล้วกด Enter
    const typed = /^[0-9.]$/.test(k) ? k : e.key;
    if (!(e.ctrlKey || e.metaKey) && viewer.typeLength(typed)) { e.preventDefault(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (!$('#keys-pop').hidden && (k === 'escape' || k === '?')) { toggleKeys(false); return; }
    if (k === 'f8') { e.preventDefault(); setOrtho(!ortho); return; }
    if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (ctrl && k === 'c') { if (selected()) { e.preventDefault(); copySelected(); } }
    else if (ctrl && k === 'x') { if (selected()) { e.preventDefault(); copySelected(true); } }
    else if (ctrl && k === 'v') { e.preventDefault(); pasteClipboard(); }
    else if (ctrl && k === 'l') { e.preventDefault(); setTool('wall'); }
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); }
    else if (ctrl && k === 's') { e.preventDefault(); saveProject(); }
    else if (ctrl) return;
    else if (k === 'escape') {
      if (tool !== 'select' && viewer.cancelDraw()) return;
      if (tool !== 'select') setTool('select'); else select(null);
    }
    else if (e.shiftKey && k === 'c') setTool('copy');
    else if (e.shiftKey && k === 'm') setTool('mirror');
    else if (e.shiftKey && k === 'r') setTool('rotate');
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
    else if (k === 'r') rotateSelected();
    else if (k === 'v') setTool('select');
    else if (k === 'c') setTool('cdu');
    else if (k === 'w' || k === 'l') setTool('wall');
    else if (k === 'm') setTool('move');
    else if (k === 'o') setTool('offset');
    else if (k === '?') toggleKeys();
    else if (k === 'tab' && (e.target === document.body || e.target.tagName === 'CANVAS')) { e.preventDefault(); cycleSelection(e.shiftKey ? -1 : 1); }
    else if (k === 'b') setTool('building');
    else if (k === 'f') setTool('slab');
    else if (k === 'p') captureView();
    else if (k >= '1' && k <= '6') setViewUI(['3d', 'n', 's', 'e', 'w', 'top'][+k - 1]);
    else if (k === ' ') { e.preventDefault(); startOrToggle(); }
    else if (k.startsWith('arrow') && selected()) {
      e.preventDefault();
      const s = e.shiftKey ? 1 : 0.1;
      nudge(k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, k === 'arrowup' ? -s : k === 'arrowdown' ? s : 0);
    }
  });
  window.addEventListener('resize', () => { drawChart(unitsNow()); drawResiduals(); });
}

function renderModelTable() {
  const rows = MODELS.map(m => `<tr><td>${m.id}</td><td class="n">${m.hp}</td><td>${m.modules.length > 1 ? m.modules.join(' + ') : '—'}</td>
    <td class="n">${m.kw.toFixed(1)}</td><td class="n">${m.cmm}</td><td class="n">${m.eer.toFixed(2)}</td>
    <td class="n">${m.width} × ${MODULE_H} × ${MODULE_D}</td><td class="n">${m.fans}</td></tr>`).join('');
  $('#model-table').innerHTML = `<tr><th>รุ่น</th><th class="n">HP</th><th>โมดูล</th><th class="n">kW</th><th class="n">m³/min</th><th class="n">EER</th><th class="n">ก × ส × ล (มม.)</th><th class="n">พัดลม</th></tr>${rows}`;
}

/* ───────── เริ่มต้น ───────── */

$('#cbar').style.background = cssGradient();
bindUI();
renderModelTable();
afterChange(false);
initSection();
updateUndoButtons();
updateRunUI();
updateColorbar();
renderResults();
renderCompare();
