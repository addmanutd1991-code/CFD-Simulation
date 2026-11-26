/*
 * main.js — ตัวควบคุมหลัก: เชื่อมหน้าจอ ↔ ข้อมูลฉาก ↔ มุมมอง 3D ↔ ตัวคำนวณ
 */

import { MODELS, SERIES, CATEGORIES, getModel, seriesOf, unitSize, elbowOpen, hasStand, status as unitStatus, hasCapTable, unitCombo, capLookup, capTableOf, capTableTmax, comboRange, CAP_RATED_T, CAP_TABLE_LABEL, COMBO_DEFAULT, EST_TEXT, EST_FIT_POINTS } from './models.js';
import { newScene, makeObject, domainOf, presetScene, PRESETS, normalizeScene, BC_FACES, insideRect } from './scene.js';
import CASE_THUMBS from './case-thumbs.js';
import { buildMesh } from './mesher.js';
import { Solver } from './solver.js';
import { GPU_BYTES_PER_CELL } from './gpu-solver.js';
import { Viewer, CONTOUR_LEVELS } from './viewer.js';
import { Runner } from './runner.js';
import { cssGradient, FIELDS, rgb } from './colormap.js';
import { L, getLang, setLang } from './i18n.js';
import { WIND_PROFILES, windParams, windFactorFn } from './wind.js';
import { parseDXF, guessUnits, simplifyCollinear, rectOf } from './dxf.js';
import { BATCH_KINDS, KIND_INFO, MAX_CASES, WIND4, CALM, buildCases, validateVars, parseValues, dirName } from './batch.js';
import { buildFormReport } from './form-report.js';

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
  onAxisView: (v) => setViewUI(v),
  newCduModel: () => lastUsed.model,
  newCduRot: () => lastUsed.rot,
  newWallHeight: () => lastUsed.wallHeight,
});

/**
 * คำนวณหลายเธรดต้องให้หน้าเว็บเป็น cross-origin isolated (เงื่อนไขของ SharedArrayBuffer)
 * เมื่อเปิดผ่าน http(s) ให้ service worker coi-sw.js เติมส่วนหัว COOP/COEP แล้วโหลดหน้าใหม่หนึ่งครั้ง
 * (เปิดจาก file:// ทำไม่ได้ — คำนวณเธรดเดียว)
 */
function enableIsolation() {
  if (globalThis.crossOriginIsolated || !('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol) || !window.isSecureContext) return;
  const KEY = 'cfd-coi-reload';
  const reloadOnce = () => {
    let done = false;
    try { done = sessionStorage.getItem(KEY) === '1'; sessionStorage.setItem(KEY, '1'); } catch { done = true; }
    if (!done) location.reload();
  };
  navigator.serviceWorker.register('coi-sw.js').then(() => {
    if (navigator.serviceWorker.controller) reloadOnce();   // ควบคุมหน้าอยู่แล้วแต่หน้านี้โหลดมาก่อน
    else navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
  }).catch(() => { /* ไม่มี service worker — ใช้เธรดเดียว */ });
}
enableIsolation();

const runner = new Runner(onEngineMessage);

/* ───────── การแก้ไขฉาก ───────── */

/* ───────── ล็อกโมเดลเมื่อมีผลคำนวณ ─────────
 * หลังกดคำนวณ แบบถูกล็อกไว้: คลิกวัตถุในภาพได้แค่เลือกดู ไม่ย้าย/แก้/ลบ — ผลจึงไม่หายเพราะคลิกพลาด
 * ต้องการปรับแบบ → กดปุ่ม แก้ไขโมเดล (ผลเดิมยังอยู่จนกว่าจะแก้จริง) */
let editUnlocked = false;
const modelLocked = () => !!run.mesh && !run.stale && !editUnlocked;

/** ถ้าโมเดลล็อกอยู่: แจ้งเตือน คืนค่าในแผงให้ตรงแบบ และคืน true (ผู้เรียกต้องหยุด) */
function blockIfLocked() {
  if (!modelLocked()) return false;
  toast(L('โมเดลล็อกอยู่เพื่อรักษาผลคำนวณ — กดปุ่ม "แก้ไขโมเดล" ก่อนปรับแบบ', 'The model is locked to keep the results — press "Edit model" before changing it'), 3000);
  const b = $('#btn-edit');
  b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge');
  renderProps();
  renderSettings();
  return true;
}

function setEditUnlocked(on) {
  if (on && batch.active) { toast(L('กำลังรัน Batch — ยกเลิก Batch ก่อนแก้แบบ', 'A batch is running — cancel the batch before editing')); return; }
  editUnlocked = on;
  if (on) toast(L('ปลดล็อกแล้ว — ผลคำนวณยังอยู่ แต่ถ้าแก้แบบ ผลเดิมจะเป็นผลเก่าและต้องคำนวณใหม่', 'Unlocked — the results stay until you change the model; any change marks them stale and needs a new run'), 4500);
  updateLockUI();
}

function updateLockUI() {
  const locked = modelLocked();
  viewer.setLocked(locked);
  if (locked && tool !== 'select') setTool('select');
  document.body.classList.toggle('model-locked', locked);
  const b = $('#btn-edit');
  b.hidden = !run.mesh || run.stale;
  b.classList.toggle('on', !locked && !b.hidden);
  $('#edit-ic').setAttribute('href', locked ? '#i-lock' : '#i-unlock');
  $('#edit-label').textContent = locked ? L('แก้ไขโมเดล', 'Edit model') : L('ล็อกโมเดล', 'Lock model');
  b.title = locked
    ? L('ปลดล็อกเพื่อปรับแบบ (ผลคำนวณยังอยู่จนกว่าจะแก้จริง)', 'Unlock to change the model (results stay until you actually change something)')
    : L('ล็อกโมเดลอีกครั้งเพื่อกันผลคำนวณหายจากการคลิกพลาด', 'Lock the model again so a stray click cannot clear the results');
  renderProps();
}

function pushUndo() {
  undoStack.push(JSON.stringify(scene));
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

function edit(fn, geom = true, force = false) {
  if (geom && !force && blockIfLocked()) return;
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
  if (!undoStack.length || blockIfLocked()) return;
  redoStack.push(JSON.stringify(scene));
  scene = JSON.parse(undoStack.pop());
  updateUndoButtons();
  afterChange(true);
}

function redo() {
  if (!redoStack.length || blockIfLocked()) return;
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
  if (blockIfLocked()) return;
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
  showSide('obj', false);
  afterChange(true);
}

function select(id) {
  selectedId = id;
  viewer.setSelected(id);
  if (id != null) showSide('obj', false);   // เลือกวัตถุ → แผงขวาแสดงคุณสมบัติ (ถ้าแผงถูกพับไว้ ไม่กางเอง)
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
  if (!o) { toast(L('เลือกวัตถุก่อน แล้วกด Ctrl+C', 'Select an object first, then press Ctrl+C')); return; }
  clipboard = JSON.parse(JSON.stringify(o));
  pasteN = 0;
  if (cut) {
    edit(() => { scene.objects = scene.objects.filter(q => q.id !== o.id); selectedId = null; });
    toast(L(`ตัด ${o.name} แล้ว — ชี้เมาส์ตรงจุดที่ต้องการแล้วกด Ctrl+V`, `Cut ${o.name} — point the mouse where you want it and press Ctrl+V`));
  } else toast(L(`คัดลอก ${o.name} แล้ว — ชี้เมาส์ตรงจุดที่ต้องการแล้วกด Ctrl+V (วางซ้ำได้)`, `Copied ${o.name} — point the mouse where you want it and press Ctrl+V (repeatable)`));
}

const refPoint = o => (o.type === 'wall' ? { x: (o.x1 + o.x2) / 2, z: (o.z1 + o.z2) / 2 } : { x: o.x, z: o.z });
/** ระดับผิวแผ่นพื้น/หลังคาที่รองรับ ณ จุด (x, z) */
const supportAt = (x, z) => scene.objects.filter(s => s.type === 'slab' && insideRect(s, x, z)).reduce((m, s) => Math.max(m, s.y), 0);

function pasteClipboard() {
  if (!clipboard) { toast(L('ยังไม่ได้คัดลอก — เลือกวัตถุแล้วกด Ctrl+C ก่อน', 'Nothing copied yet — select an object and press Ctrl+C first')); return; }
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
  toast(L(`ย้าย ${o.name} ${fmt(Math.hypot(dx, dz))} m`, `Moved ${o.name} ${fmt(Math.hypot(dx, dz))} m`), 1800);
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
  toast(on ? L('Ortho เปิด — ผนัง/Move ล็อกตามแนวแกน X/Z (Shift = ปลดชั่วคราว)', 'Ortho on — walls/Move lock to the X/Z axes (Shift = temporary release)') : L('Ortho ปิด', 'Ortho off'), 1600);
}

function toggleCases(show) {
  const el = $('#cases-pop');
  el.hidden = show === undefined ? !el.hidden : !show;
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

const TOOL_HINT = () => ({
  cdu: L('คลิกบนพื้นภายในกริดแกนเพื่อวาง CDU · วางต่อได้หลายตัว · คลิกโดนวัตถุเดิม = เลือกเพื่อแก้ไข · Esc เพื่อจบ', 'Click the floor inside the grid to place a CDU · keep clicking for more · clicking an existing object selects it · Esc to finish'),
  wall: L('คลิกจุดเริ่ม แล้วคลิกจุดถัดไป (ต่อเนื่องได้ ภายในกริดแกน) · พิมพ์ความยาว (ม.) + Enter ตามทิศเมาส์ · F8 Ortho / Shift ล็อกแนวแกน · คลิกกลางผนังเดิม = เลือก · ดับเบิลคลิก/Esc เพื่อจบ', 'Click the start point, then the next points (continuous, inside the grid) · type a length (m) + Enter along the mouse direction · F8 Ortho / Shift locks to the axes · clicking the middle of an existing wall selects it · double-click/Esc to finish'),
  slab: L('คลิกมุมหนึ่งของแผ่นพื้น/หลังคา แล้วคลิกมุมตรงข้าม · ตั้งระดับความสูงที่แผงด้านขวา · Esc เพื่อจบ', 'Click one corner of the slab/roof, then the opposite corner · set its level in the right panel · Esc to finish'),
  move: L('Move: เลือกวัตถุ → จุดฐาน → จุดที่สอง หรือพิมพ์ระยะ + Enter · F8 Ortho · Esc ยกเลิก', 'Move: pick an object → base point → second point, or type a distance + Enter · F8 Ortho · Esc cancels'),
  copy: L('Copy: เลือกวัตถุ → จุดฐาน → คลิกวางสำเนาได้หลายครั้ง หรือพิมพ์ระยะ + Enter · F8 Ortho · Esc จบ', 'Copy: pick an object → base point → click to place copies repeatedly, or type a distance + Enter · F8 Ortho · Esc to finish'),
  mirror: L('Mirror: เลือกวัตถุ → คลิกจุดแรกและจุดที่สองของเส้นสะท้อน (ได้สำเนา ต้นฉบับคงเดิม) · F8 Ortho · Esc ยกเลิก', 'Mirror: pick an object → click the first and second points of the mirror line (makes a copy; the original stays) · F8 Ortho · Esc cancels'),
  rotate: L('Rotate: เลือกวัตถุ → จุดฐาน → พิมพ์มุม (องศา, + ทวนเข็ม / − ตามเข็ม) + Enter หรือคลิก · CDU ทีละ 90° · Esc ยกเลิก', 'Rotate: pick an object → base point → type an angle (degrees, + counter-clockwise / − clockwise) + Enter, or click · CDUs in 90° steps · Esc cancels'),
  offset: L('Offset: พิมพ์ระยะ + Enter → คลิกวัตถุ → คลิกฝั่ง (CDU/อาคาร = ช่องว่างระหว่างขอบ) · Esc จบ', 'Offset: type a distance + Enter → click an object → click a side (CDU/building = gap between edges) · Esc to finish'),
  pull: L('Pull: เลือกผนัง / louver / อาคาร / พื้น → คลิกปลายหรือด้านที่จะยืดหด → ลากแล้วคลิก หรือพิมพ์ระยะ + Enter (ด้านตรงข้ามอยู่กับที่) · Esc ยกเลิก', 'Pull: pick a wall / louver / building / slab → click the end or side to stretch → move and click, or type a distance + Enter (the opposite side stays put) · Esc cancels'),
  building: L('คลิกมุมหนึ่งของอาคาร แล้วคลิกมุมตรงข้าม · Esc เพื่อจบ', 'Click one corner of the building, then the opposite corner · Esc to finish'),
});

function setTool(t) {
  if (t !== 'select' && blockIfLocked()) t = 'select';
  tool = t;
  viewer.setTool(t);
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  const th = $('#toolhint');
  th.hidden = t === 'select';
  th.textContent = TOOL_HINT()[t] || '';
}

/* ───────── แผงคุณสมบัติ ───────── */

const TYPE_ICON = { cdu: 'i-cdu', wall: 'i-wall', building: 'i-building', slab: 'i-slab' };
const TYPE_TITLE = () => ({ cdu: L('คอยล์ร้อน (CDU)', 'Condensing unit (CDU)'), wall: L('ผนัง / louver', 'Wall / louver'), building: L('อาคาร', 'Building'), slab: L('พื้น / หลังคา', 'Slab / roof') });

function renderProps() {
  const box = $('#props');
  const o = selected();
  if (!o) {
    $('#props-title').textContent = L(`วัตถุในฉาก (${scene.objects.length})`, `Objects in scene (${scene.objects.length})`);
    if (!scene.objects.length) {
      box.innerHTML = `<p class="muted small">${L('ยังไม่มีวัตถุ — เลือกเครื่องมือ CDU / ผนัง / อาคาร / พื้น ที่แถบด้านซ้าย แล้วคลิกบนพื้นในภาพ', 'No objects yet — pick the CDU / Wall / Building / Slab tool on the left bar, then click the floor in the view')}</p>`;
      return;
    }
    const order = { cdu: 0, wall: 1, building: 2, slab: 3 };
    const items = [...scene.objects].sort((a, b) => order[a.type] - order[b.type] || a.id - b.id);
    box.innerHTML = `<ul class="obj-list">${items.map(q => `
      <li data-id="${q.id}"><span class="ico"><svg class="ic"><use href="#${TYPE_ICON[q.type]}"/></svg></span>${esc(q.name)}
      <span class="sub">${q.type === 'cdu' ? esc(q.model) : q.type === 'wall' ? (q.louver > 0 ? 'louver ' + q.louver + '%' : L('ทึบ', 'solid')) : q.type === 'slab' ? '+' + fmt(q.y) + ' m' + (q.open > 0 ? L(' · เปิด ', ' · open ') + q.open + '%' : '') : fmt(q.h) + ' m'}</span></li>`).join('')}</ul>
      <p class="muted small" style="margin:10px 2px 0">${L('คลิกรายการหรือคลิกวัตถุใน 3D เพื่อแก้ไข', 'Click an item or an object in 3D to edit it')}</p>`;
    $$('li', box).forEach(li => li.addEventListener('click', () => select(Number(li.dataset.id))));
    return;
  }

  $('#props-title').textContent = TYPE_TITLE()[o.type];
  let html = `<div class="form">
    <label class="row">${L('ชื่อ', 'Name')} <input type="text" data-k="name" value="${esc(o.name)}"></label>`;
  if (o.type === 'cdu') {
    const m = getModel(o.model);
    const opt = x => `<option value="${x.id}" ${x.id === o.model ? 'selected' : ''}>${x.indoor ? x.indoor + ' / ' : ''}${x.id}${seriesOf(x).cat === 'split' ? ` (HxWxD - ${x.height}x${x.width}x${x.depth}) — ` : ` — ${x.hp} HP · `}${x.kw.toFixed(1)} kW</option>`;
    // หมวดหมู่ (VRV / Split type) เลือกก่อน แล้วรายการรุ่นแสดงเฉพาะหมวดนั้น
    const cat = seriesOf(m).cat;
    const groups = SERIES.filter(sr => sr.cat === cat).flatMap(sr => {
      const list = MODELS.filter(x => x.series === sr.key);
      if (sr.key !== '6A') return [[`${sr.label} (${sr.code}) ${L('— เป่าลมหน้า', '— front discharge')}`, list]];
      return [[`${sr.label} ${L('— โมดูลเดี่ยว', '— single module')}`, list.filter(x => x.modules.length === 1)], [`${sr.label} ${L('— ชุดคอมบิเนชัน', '— combinations')}`, list.filter(x => x.modules.length > 1)]];
    }).map(([l, list]) => `<optgroup label="${l}">${list.map(opt).join('')}</optgroup>`).join('');
    const sz = unitSize(o);
    const front = m.discharge === 'front';
    const seg = (key, cur, items) => `<div class="seg" data-seg="${key}">${items.map(([v, l]) =>
      `<button data-v="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const hoodHtml = front ? `
      <div class="row row-block">${L('ทิศทางลมร้อนออกจากเครื่อง', 'Hot-air discharge direction')} ${seg('deflect', o.deflect || 'none', [['none', L('ตรง', 'Straight')], ['up', L('ขึ้น 45°', 'Up 45°')], ['down', L('ลง 45°', 'Down 45°')], ['left', L('ซ้าย 45°', 'Left 45°')], ['right', L('ขวา 45°', 'Right 45°')]])}</div>
      <label class="row">${L('Hood ยื่นจากหน้าพัดลม (ม.)', 'Hood length from fan face (m)')} <input type="number" step="0.1" min="0" max="3" data-k="duct" value="${fmt(o.duct || 0)}"></label>
      <p class="note">${L('ทิศทางลมร้อน = ใบเบี่ยงลมที่ติดกับเครื่อง (ไม่วาดรูปทรง ลูกศรสีส้มแสดงทิศ) · ซ้าย/ขวามองจากด้านหน้าเครื่อง', 'Discharge direction = a deflector fitted to the unit (not drawn; the orange arrow shows the direction) · left/right as seen from the front of the unit')}
        ${L('· Hood = ท่อสี่เหลี่ยม', '· Hood = a square duct')} ${Math.round(m.fan.s * 1000)} × ${Math.round(m.fan.s * 1000)} ${L('มม. ครอบหน้ากากพัดลม (0 = ไม่มี Hood)', 'mm over the fan grille (0 = no hood)')}</p>` : `
      <div class="row">${L('รูปแบบ Hood', 'Hood type')} ${seg('hoodType', o.hoodType || 'straight', [['straight', L('ตรง (เป่าขึ้น)', 'Straight (up)')], ['elbow', L('ท่อโค้ง 90°', '90° elbow')]])}</div>
      <label class="row">${L('ความสูง Hood (ม.)', 'Hood height (m)')} <input type="number" step="0.1" min="0" max="3" data-k="duct" value="${fmt(o.duct || 0)}"></label>
      ${o.hoodType === 'elbow' ? `
      <label class="row">${L('ระยะยื่นออกด้านปากลม (ม.)', 'Outlet overhang (m)')} <input type="number" step="0.1" min="0" max="3" data-k="hoodOut" value="${fmt(o.hoodOut || 0)}"></label>
      <div class="row">${L('ปากลม Hood หันไป', 'Hood outlet faces')} ${seg('hoodDir', o.hoodDir || 'front', [['front', L('หน้า', 'Front')], ['back', L('หลัง', 'Back')], ['left', L('ซ้าย', 'Left')], ['right', L('ขวา', 'Right')]])}</div>` : ''}
      <p class="note">${L('ความสูง 0 = ไม่มี Hood · Hood แยกรายโมดูล · Hood ตรง: ท่อสี่เหลี่ยมขนาดเท่าเครื่อง ปากลมสูงขึ้นตามความสูงที่ตั้ง', 'Height 0 = no hood · one hood per module · straight hood: a rectangular duct the size of the unit, raising the outlet by the set height')}
        ${o.hoodType === 'elbow' ? `${L('· ท่อโค้ง 90°: ท่อขึ้นจากเครื่องถึงความสูงที่ตั้ง โค้งด้านบน แล้วยื่นพ้นตัวเครื่องตามระยะยื่น', '· 90° elbow: the duct rises to the set height, bends at the top, then extends past the unit by the overhang;')}
        ${L('ลมออกแนวนอนที่ปลายท่อ (หน้าตัดสูง', 'air leaves horizontally at its end (opening height')} ${Math.round(1000 * elbowOpen(o))} ${L('มม.', 'mm')})` : ''}
        ${o.hoodType === 'elbow' && m.modules.length > 1 ? L('· ปากลมซ้าย/ขวาใช้ได้กับเครื่องโมดูลเดี่ยว', '· left/right outlets only work on single-module units') : ''}</p>`;
    html += `
      <div class="row">${L('หมวด', 'Category')} ${seg('cat', cat, CATEGORIES.map(c => [c.key, c.label]))}</div>
      <label class="row row-stack">${L('รุ่น', 'Model')} <select data-k="model">${groups}</select></label>
      <div class="row">${L('ตำแหน่ง x, z (ม.)', 'Position x, z (m)')} <span class="xz"><input type="number" step="0.1" data-k="x" value="${fmt(o.x)}"><input type="number" step="0.1" data-k="z" value="${fmt(o.z)}"></span></div>
      <div class="row">${L('ด้านหน้าเครื่องหันไป', 'Unit front faces')} <div class="seg" data-seg="rot">
        ${[[0, L('ใต้', 'S')], [90, L('ตอ.', 'E')], [180, L('เหนือ', 'N')], [270, L('ตต.', 'W')]].map(([v, l]) => `<button data-v="${v}" class="${o.rot === v ? 'on' : ''}">${l}</button>`).join('')}
      </div></div>
      <label class="row">${L('ความสูงฐาน (ม.)', 'Base height (m)')} <input type="number" step="0.05" min="0" max="60" data-k="elev" value="${fmt(o.elev)}"></label>
      <p class="note">${hasStand(o, (o.elev || 0) - supportAt(o.x, o.z))
        ? L('มีขาตั้ง (VRV 6A ยกไม่เกิน 10 ซม.)', 'With stand (VRV 6A, raised ≤ 10 cm)')
        : L('ไม่มีขาตั้ง — เครื่องลอยเหนือพื้น ลมผ่านใต้เครื่องได้ (ขาตั้งใส่เฉพาะ VRV 6A ยกไม่เกิน 10 ซม.)', 'No stand — unit floats above the floor, air passes underneath (stands only on VRV 6A raised ≤ 10 cm)')}</p>
      ${hoodHtml}
      <label class="row">${L('อัตราลม (m³/min)', 'Airflow (m³/min)')} <input type="number" step="1" min="30" max="2000" data-k="airflow" value="${fmt(o.airflow || m.cmm)}"></label>
      <div class="spec">
        ${seriesOf(m).label}${m.indoor ? ` · ${L('คอยล์เย็น', 'indoor unit')} <b>${m.indoor}</b>` : ''} · ${front ? L('เป่าลมออกด้านหน้า', 'front discharge') : L('เป่าลมขึ้นด้านบน', 'top discharge')}<br>
        ${m.modules.length > 1 ? `${L('ชุด', 'Set')} <b>${m.modules.map(h => h + 'HP').join(' + ')}</b> · ` : ''}${L('ทำความเย็น', 'Cooling')} <b>${m.kw.toFixed(1)} kW</b> · EER <b>${m.eer.toFixed(2)}</b><br>
        ${L('ขนาด (ก × ส × ล)', 'Size (W × H × D)')} <b>${Math.round(sz.w * 1000)} × ${Math.round(sz.h * 1000)} × ${Math.round(sz.d * 1000)}</b> ${L('มม. · พัดลม', 'mm · fans')} <b>${m.fans}</b>${L(' ใบ', '')}<br>
        ${L('อัตราลมมาตรฐาน', 'Standard airflow')} <b>${m.cmm}</b> m³/min${o.airflow ? ` · <a href="#" data-reset-air>${L('ใช้ค่ามาตรฐาน', 'use standard')}</a>` : ''}
      </div>
      ${hasCapTable(o) ? comboHtml(o, m) : ''}`;
    const ur = unitsNow()?.find(u => u.id === o.id);
    if (ur) {
      html += `<div class="unit-res st-${ur.status.key}">${L('T ลมเข้า', 'Inlet T')} <span>${ur.Tin.toFixed(1)} °C</span> (ΔT <span>+${ur.dT.toFixed(2)} °C</span>)
        · ${L('ลมวนกลับ', 'recirculation')} <span>${(ur.Cin * 100).toFixed(1)}%</span><br>capacity <span>${(ur.capF * 100).toFixed(1)}%</span>
        = <span>${ur.kwAvail.toFixed(1)}</span> / ${ur.kwRated.toFixed(1)} kW · <b class="st-${ur.status.key}">${ur.status.label}</b>${ur.est ? `<br><span class="est">(${EST_TEXT()})</span>` : ''}</div>`;
    }
  } else if (o.type === 'wall') {
    const wallLen = Math.hypot(o.x2 - o.x1, o.z2 - o.z1);
    html += `
      <div class="row">${L('จุดเริ่ม x, z', 'Start x, z')} <span class="xz"><input type="number" step="0.1" data-k="x1" value="${fmt(o.x1)}"><input type="number" step="0.1" data-k="z1" value="${fmt(o.z1)}"></span></div>
      <div class="row">${L('จุดปลาย x, z', 'End x, z')} <span class="xz"><input type="number" step="0.1" data-k="x2" value="${fmt(o.x2)}"><input type="number" step="0.1" data-k="z2" value="${fmt(o.z2)}"></span></div>
      <label class="row">${L('ความยาว (ม.)', 'Length (m)')} <input type="number" step="0.1" min="0.1" data-wall="len" value="${fmt(wallLen)}"></label>
      <label class="row">${L('มุมแนวผนัง (°)', 'Wall angle (°)')} <input type="number" step="15" data-wall="ang" value="${fmt(wallAngle(o))}"></label>
      <div class="row">${L('ยืดความยาวจาก', 'Resize from')} <div class="seg" data-seg="anchor">
        ${[['start', L('จุดเริ่ม', 'Start')], ['mid', L('กึ่งกลาง', 'Middle')], ['end', L('จุดปลาย', 'End')]].map(([v, l]) => `<button data-v="${v}" class="${wallAnchor === v ? 'on' : ''}">${l}</button>`).join('')}
      </div></div>
      <label class="row">${L('ความสูง (ม.)', 'Height (m)')} <input type="number" step="0.1" min="0.2" max="30" data-k="height" value="${fmt(o.height)}"></label>
      <label class="row">${L('ความหนา (ม.)', 'Thickness (m)')} <input type="number" step="0.05" min="0.05" max="1" data-k="thick" value="${fmt(o.thick)}"></label>
      <label class="row">${L('ช่องว่างใต้ผนัง (ม.)', 'Gap under wall (m)')} <input type="number" step="0.1" min="0" max="5" data-k="gap" value="${fmt(o.gap || 0)}"></label>
      <label class="row">${L('พื้นที่เปิด louver', 'Louver open area')} <span class="mono val">${o.louver > 0 ? o.louver + '%' : L('ทึบ', 'solid')}</span></label>
      <input type="range" min="0" max="95" step="5" data-k="louver" value="${o.louver}">
      <p class="note">${L('0% = ผนังทึบ · louver ทั่วไปมีพื้นที่เปิด 40–60% · พิมพ์ความยาว/มุมได้โดยตรง หรือลากปุ่มกลมที่ปลายผนัง', '0% = solid wall · typical louvers are 40–60% open · type the length/angle directly, or drag the round handles at the wall ends')}
        ${L('· มุม 0° = ไปทางตะวันออก (+x), 90° = ไปทางใต้ (+z)', '· angle 0° = towards east (+x), 90° = towards south (+z)')}</p>`;
  } else if (o.type === 'slab') {
    html += `
      <div class="row">${L('ศูนย์กลาง x, z', 'Centre x, z')} <span class="xz"><input type="number" step="0.1" data-k="x" value="${fmt(o.x)}"><input type="number" step="0.1" data-k="z" value="${fmt(o.z)}"></span></div>
      <div class="row">${L('กว้าง × ยาว (ม.)', 'Width × length (m)')} <span class="xz"><input type="number" step="0.1" min="0.3" data-k="w" value="${fmt(o.w)}"><input type="number" step="0.1" min="0.3" data-k="d" value="${fmt(o.d)}"></span></div>
      <label class="row">${L('ระดับผิวบน (ม.)', 'Top level (m)')} <input type="number" step="0.1" min="0" max="60" data-k="y" value="${fmt(o.y)}"></label>
      <label class="row">${L('ความหนา (ม.)', 'Thickness (m)')} <input type="number" step="0.05" min="0.05" max="2" data-k="thick" value="${fmt(o.thick)}"></label>
      <label class="row">${L('มุมหมุน (°)', 'Rotation (°)')} <input type="number" step="15" data-k="rot" value="${fmt(o.rot)}"></label>
      <label class="row">${L('ช่องเปิด (ตะแกรง)', 'Open area (grating)')} <span class="mono val">${o.open > 0 ? o.open + '%' : L('ทึบ', 'solid')}</span></label>
      <input type="range" min="0" max="95" step="5" data-k="open" value="${o.open || 0}">
      <p class="note">${L('ใช้เป็นพื้นยก (ชั้นลอย/แท่นวางเครื่อง) หรือหลังคาคลุมลาน · ผิวบนอยู่ที่ระดับที่ตั้ง หนาลงด้านล่าง', 'Use as a raised floor (mezzanine/plinth) or a roof over the yard · the top surface sits at the set level, thickness goes downward')}
        ${L('· 0% = แผ่นทึบ (คอนกรีต/หลังคา) · ตะแกรงเหล็ก (grating) ทั่วไปเปิด 60–80%', '· 0% = solid slab (concrete/roof) · typical steel grating is 60–80% open')}
        ${L('· CDU ที่วางบนแผ่นนี้จะยกฐานขึ้นไปบนผิวแผ่นอัตโนมัติ', '· CDUs placed on this slab are raised onto its surface automatically')}</p>`;
  } else {
    html += `
      <div class="row">${L('ศูนย์กลาง x, z', 'Centre x, z')} <span class="xz"><input type="number" step="0.1" data-k="x" value="${fmt(o.x)}"><input type="number" step="0.1" data-k="z" value="${fmt(o.z)}"></span></div>
      <div class="row">${L('กว้าง × ลึก (ม.)', 'Width × depth (m)')} <span class="xz"><input type="number" step="0.1" min="0.3" data-k="w" value="${fmt(o.w)}"><input type="number" step="0.1" min="0.3" data-k="d" value="${fmt(o.d)}"></span></div>
      <label class="row">${L('ความสูง (ม.)', 'Height (m)')} <input type="number" step="0.1" min="0.3" max="60" data-k="h" value="${fmt(o.h)}"></label>
      <label class="row">${L('มุมหมุน (°)', 'Rotation (°)')} <input type="number" step="15" data-k="rot" value="${fmt(o.rot)}"></label>`;
  }
  html += `</div>
    <div class="props-actions">
      <button data-act="dup" title="Ctrl+D">${L('ทำสำเนา', 'Duplicate')}</button>
      <button data-act="rot" title="${L('หมุน 90° ทวนเข็ม (R)', 'Rotate 90° counter-clockwise (R)')}">${L('หมุน 90°', 'Rotate 90°')}</button>
      <button data-act="del" class="danger" title="Delete">${L('ลบ', 'Delete')}</button>
      <span class="spacer"></span>
      <button data-act="close" class="ghost" title="Esc">${L('ปิด', 'Close')}</button>
    </div>`;
  box.innerHTML = html;
  if (modelLocked()) {
    // มีผลคำนวณอยู่ → ดูค่าได้ แก้ไม่ได้ (ยกเว้นชื่อ) จนกว่าจะกด แก้ไขโมเดล
    box.insertAdjacentHTML('afterbegin', `<div class="lock-note"><svg class="ic"><use href="#i-lock"/></svg>
      <span>${L('โมเดลล็อกอยู่เพื่อรักษาผลคำนวณ', 'Model locked to keep the results')}</span>
      <button data-act="unlock">${L('แก้ไขโมเดล', 'Edit model')}</button></div>`);
    $$('input, select, textarea, button', box).forEach(el => {
      if (el.dataset.k === 'name' || el.dataset.act === 'close' || el.dataset.act === 'unlock') return;
      el.disabled = true;
    });
    $('[data-act="unlock"]', box).addEventListener('click', () => setEditUnlocked(true));
  }

  const NUM = new Set(['combo', 'x', 'z', 'elev', 'duct', 'hoodOut', 'airflow', 'x1', 'z1', 'x2', 'z2', 'height', 'thick', 'gap', 'louver', 'w', 'd', 'h', 'rot', 'y', 'open']);
  $$('[data-k]', box).forEach(inp => {
    const k = inp.dataset.k;
    const ev = inp.type === 'range' ? 'input' : 'change';
    inp.addEventListener(ev, () => {
      let v = inp.value;
      if (NUM.has(k)) {
        v = parseFloat(v);
        if (!isFinite(v)) { renderProps(); return; }
        if (k === 'elev' || k === 'duct' || k === 'hoodOut' || k === 'gap' || k === 'y') v = Math.max(0, v);
        if (k === 'height' || k === 'h' || k === 'w' || k === 'd' || k === 'thick') v = Math.max(0.05, v);
        if (k === 'combo') { const [lo, hi] = comboRange(o); v = Math.min(hi, Math.max(lo, Math.round(v))); }
      }
      if (inp.type === 'range') {
        // เลื่อนแถบ: บันทึก undo ครั้งเดียวต่อการลาก
        if (!inp._pushed) { if (blockIfLocked()) return; pushUndo(); inp._pushed = true; }
        o[k] = v;
        if (k === 'louver') lastUsed.louver = v;
        inp.previousElementSibling?.querySelector('.val') && (inp.previousElementSibling.querySelector('.val').textContent = v > 0 ? v + '%' : L('ทึบ', 'solid'));
        viewer.refreshObject(o);
        invalidate();
        saveAutosave();
        return;
      }
      if (k === 'airflow' && Math.abs(v - getModel(o.model).cmm) < 0.5) v = null;
      edit(() => {
        if (k === 'model') {
          // เปลี่ยนชนิดการเป่าลม (ขึ้น ↔ หน้า): ความหมายของ Hood ต่างกัน จึงล้างค่า Hood เดิม
          if (getModel(v).discharge !== getModel(o.model).discharge) { o.duct = 0; o.deflect = 'none'; o.hoodType = 'straight'; }
          lastUsed.model = v; o.airflow = null;
        }
        o[k] = v;
        if (k === 'height' && o.type === 'wall') lastUsed.wallHeight = v;
      }, k !== 'name');
    });
    if (inp.type === 'range') inp.addEventListener('change', () => { if (!inp._pushed) return; inp._pushed = false; afterChange(true); });
  });
  // ผนัง: แก้ความยาว/มุมโดยพิมพ์ค่า — คงตำแหน่งจุดยึดที่เลือกไว้
  $$('[data-wall]', box).forEach(inp => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) { renderProps(); return; }
    const len = inp.dataset.wall === 'len' ? Math.max(0.1, v) : Math.hypot(o.x2 - o.x1, o.z2 - o.z1);
    const a = (inp.dataset.wall === 'ang' ? v : wallAngle(o)) * Math.PI / 180;
    edit(() => setWallGeometry(o, len, a, wallAnchor));
  }));
  $$('[data-seg="anchor"] button', box).forEach(b => b.addEventListener('click', () => {
    wallAnchor = b.dataset.v;
    $$('[data-seg="anchor"] button', box).forEach(q => q.classList.toggle('on', q === b));
  }));
  // เปลี่ยนหมวด: สลับไปรุ่นแรกของหมวดนั้น (ล้างค่า Hood/อัตราลมที่ความหมายต่างกัน)
  $$('[data-seg="cat"] button', box).forEach(b => b.addEventListener('click', () => {
    if (seriesOf(getModel(o.model)).cat === b.dataset.v) return;
    const first = MODELS.find(x => seriesOf(x).cat === b.dataset.v);
    if (!first) return;
    edit(() => {
      if (first.discharge !== getModel(o.model).discharge) { o.duct = 0; o.deflect = 'none'; o.hoodType = 'straight'; }
      o.model = first.id; o.airflow = null; lastUsed.model = first.id;
    });
  }));
  for (const key of ['deflect', 'hoodType', 'hoodDir'])
    $$(`[data-seg="${key}"] button`, box).forEach(b => b.addEventListener('click', () => edit(() => { o[key] = b.dataset.v; })));
  $$('[data-seg="rot"] button', box).forEach(b => b.addEventListener('click', () => {
    edit(() => { o.rot = Number(b.dataset.v); lastUsed.rot = o.rot; });
  }));
  $('[data-reset-air]', box)?.addEventListener('click', (e) => { e.preventDefault(); edit(() => { o.airflow = null; }); });
  // Combination ratio (VRV 6A): ซ่อนไว้จนกว่าจะเลือก — ไม่เลือก = 100 %
  $('[data-combo-on]', box)?.addEventListener('change', (e) => edit(() => { o.combo = e.target.checked ? COMBO_DEFAULT : null; }));
  $('[data-act="dup"]', box).addEventListener('click', duplicateSelected);
  $('[data-act="rot"]', box).addEventListener('click', rotateSelected);
  $('[data-act="del"]', box).addEventListener('click', deleteSelected);
  $('[data-act="close"]', box).addEventListener('click', () => select(null));
}

let wallAnchor = 'start';

/** อุณหภูมิลมเข้าคอยล์ที่แสดงในตาราง capacity ของแผงคุณสมบัติ (°C) */
const COMBO_TEMPS = [35, 37, 39, 41, 43, 45, 47, 50, 52, 55];
/** ช่วงแกนอุณหภูมิของกราฟ capacity (°C) */
const CHART_T0 = 10, CHART_T1 = 55;

/** ป้ายกำกับค่า capacity ที่เกินช่วงตาราง (ตารางผลลัพธ์) */
function estTag(on) { return on ? ` <span class="est" title="${esc(EST_TEXT())}">(Estimate)</span>` : ''; }

/**
 * กราฟ capacity (kW) เทียบอุณหภูมิลมเข้าของ combination ที่เลือก — เส้นทึบ = ตาราง, เส้นประ = Estimate
 *   จุดบนเส้นทึบ = จุดในตาราง · เส้นแนวตั้งประ = อากาศภายนอก · ชี้ที่จุดเพื่อดูค่า
 */
function capChartSvg(capAt, tblTemps, tMax, amb) {
  const W = 300, H = 160, pl = 34, pr = 8, pt = 18, pb = 24;
  const t1 = Math.max(CHART_T1, Math.ceil(amb));
  const all = [];
  for (let T = CHART_T0; T <= t1; T++) all.push({ T, ...capAt(T) });
  const yMax = Math.ceil(Math.max(...all.map(p => p.kw)) * 1.1 / 5) * 5 || 5;
  const x = T => pl + (T - CHART_T0) / (t1 - CHART_T0) * (W - pl - pr);
  const y = v => pt + (1 - v / yMax) * (H - pt - pb);
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.T).toFixed(1)},${y(p.kw).toFixed(1)}`).join('');
  const tbl = all.filter(p => p.T <= tMax), est = all.filter(p => p.T >= tMax);
  const yTicks = [0, yMax / 2, yMax];
  const xTicks = [10, 20, 30, 40, 50].filter(T => T <= t1);
  const marks = tblTemps.filter(T => T >= CHART_T0).map(T => {
    const r = capAt(T);
    return `<circle cx="${x(T).toFixed(1)}" cy="${y(r.kw).toFixed(1)}" r="5" class="cc-hit"><title>${T} °C · ${r.kw.toFixed(1)} kW</title></circle>`;
  }).join('');
  const hits = est.filter(p => p.T > tMax && p.T % 2 === 1).map(p =>
    `<circle cx="${x(p.T).toFixed(1)}" cy="${y(p.kw).toFixed(1)}" r="5" class="cc-hit"><title>${p.T} °C · ${p.kw.toFixed(1)} kW (Estimate)</title></circle>`).join('');
  return `<svg class="cap-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${L('กราฟ capacity เทียบอุณหภูมิลมเข้า', 'Capacity vs inlet temperature')}">
    ${yTicks.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="cc-grid"/><text x="${pl - 4}" y="${y(v) + 3.5}" class="cc-ax" text-anchor="end">${fmt(v)}</text>`).join('')}
    ${xTicks.map(T => `<text x="${x(T)}" y="${H - 8}" class="cc-ax" text-anchor="middle">${T}</text>`).join('')}
    <text x="${W - pr}" y="${H - 8}" class="cc-ax" text-anchor="end">°C</text>
    <text x="${pl}" y="9" class="cc-ax">kW</text>
    <line x1="${x(tMax)}" x2="${x(tMax)}" y1="${pt}" y2="${H - pb}" class="cc-edge"/>
    <line x1="${x(amb)}" x2="${x(amb)}" y1="${pt}" y2="${H - pb}" class="cc-amb"><title>${L('อากาศภายนอก', 'Ambient')} ${fmt(amb)} °C</title></line>
    <path d="${path(tbl)}" class="cc-line"/>
    ${est.length > 1 ? `<path d="${path(est)}" class="cc-line cc-est"/><text x="${Math.min(W - pr, x(tMax) + 4)}" y="9" class="cc-tag">Estimate</text>` : ''}
    ${marks}${hits}
  </svg>`;
}

/**
 * ส่วน Combination ratio ของเครื่องที่มีตาราง capacity (VRV 6A / VRV IV S / VRV S Hi) ในแผงคุณสมบัติ
 *   ตัวเลือกปิดอยู่ = ใช้ Combination 100 % (ค่าเริ่มต้น) · เปิดแล้วจึงแสดงช่องกรอก กราฟ และตาราง capacity เทียบอุณหภูมิลมเข้า
 *   ช่วงที่เกินตาราง = Estimate จากเส้นแนวโน้มของตารางรุ่นนั้นเอง (ไม่ได้อ้างอิงจาก Engineering Data)
 */
function comboHtml(o, m) {
  const on = o.combo != null, c = unitCombo(o), [lo, hi] = comboRange(o);
  const tbl = capTableOf(o), tMax = capTableTmax(o), label = CAP_TABLE_LABEL[m.series];
  // VRV 6A: ตารางทั้งระบบ (8 – 60 HP) · ชุดที่เกิน 60 HP รวมจากตารางของแต่ละโมดูล · VRV IV S / S Hi: ตารางตามรหัสรุ่น
  const key = m.series === '6A' ? (tbl.data[m.hp] ? m.hp : null) : m.id;
  const capAt = (T) => {
    if (key != null) {
      const r = capLookup(m.series, key, c, T);
      return { kw: r.tc * m.kw / capLookup(m.series, key, 100, CAP_RATED_T).tc, est: r.est };
    }
    const rs = m.modules.map(h => capLookup(m.series, h, c, T));
    return { kw: rs.reduce((s, r) => s + r.tc * m.kwScale, 0), est: rs.some(r => r.est) };
  };
  const ref = capAt(CAP_RATED_T).kw, amb = scene.site.ambient;
  const temps = [...new Set([amb, ...COMBO_TEMPS])].filter(t => t >= CAP_RATED_T || t === amb).sort((a, b) => a - b);
  const rows = temps.map(t => {
    const r = capAt(t);
    return `<tr class="${t === amb ? 'amb' : ''}${r.est ? ' est' : ''}"><td class="n">${fmt(t)}${t === amb ? '*' : ''}</td><td class="n">${r.kw.toFixed(1)}</td><td class="n">${(r.kw / ref * 100).toFixed(1)}</td><td class="tag">${r.est ? '(Estimate)' : ''}</td></tr>`;
  }).join('');
  const estNote = `<br><span class="est">(Estimate) = ${EST_TEXT()}</span> — ${L(
    `ตารางของรุ่นนี้ถึง ${tMax} °C · ส่วนที่เกินต่อเส้นแนวโน้ม (เส้นตรง least-squares ของ ${EST_FIT_POINTS} จุดสุดท้าย) ของตารางรุ่นนี้เอง: TC = ค่าต่ำกว่าระหว่างเส้นของ combination ที่เลือกกับเส้นของ combination ${hi}% (capacity สูงสุดของคอยล์ร้อน)`,
    `this model's table ends at ${tMax} °C · beyond that the model's own trend (least-squares line through its last ${EST_FIT_POINTS} points) is extended: TC = the lower of the selected combination's line and the ${hi}% line (maximum outdoor capacity)`)}`;
  const estDefault = L(` · T ลมเข้าเกิน ${tMax} °C เป็น Estimate (ไม่ได้อ้างอิงจาก Engineering Data)`, ` · inlet T above ${tMax} °C is an estimate (not based on Engineering Data)`);
  return `
      <label class="chk combo-chk"><input type="checkbox" data-combo-on ${on ? 'checked' : ''}><span>${L('กำหนด Combination ratio', 'Set combination ratio')}</span></label>
      ${on ? `<div class="combo-box">
        <label class="row">${L('Combination ratio (%)', 'Combination ratio (%)')} <input type="number" step="10" min="${lo}" max="${hi}" data-k="combo" value="${c}"></label>
        <div class="cap-chart-h">${L(`Capacity ${label} · combination ${c}%`, `${label} capacity · combination ${c}%`)}</div>
        ${capChartSvg(capAt, tbl.temps, tMax, amb)}
        <table class="combo-tbl"><thead><tr><th>${L('T ลมเข้า °C', 'Inlet °C')}</th><th>kW</th><th>%</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <p class="note">${L(`ตาราง Cooling Capacity ${label} (${tbl.temps[0]} – ${tMax} °C, combination ${lo} – ${hi}%) · คอยล์เย็น ${tbl.wb} °CWB · % เทียบ capacity ที่ ${CAP_RATED_T} °C ของ combination เดียวกัน (${ref.toFixed(1)} kW)`, `${label} cooling capacity table (${tbl.temps[0]} – ${tMax} °C, combination ${lo} – ${hi}%) · indoor ${tbl.wb} °CWB · % relative to the capacity at ${CAP_RATED_T} °C for the same combination (${ref.toFixed(1)} kW)`)}
          ${L(`· * = อากาศภายนอก ${fmt(amb)} °C · ค่าระหว่างจุดตารางใช้การเทียบเส้นตรง`, `· * = ambient ${fmt(amb)} °C · values between table points are interpolated linearly`)}${estNote}</p>
      </div>` : `<p class="note">${L(`capacity ใช้ Combination ${COMBO_DEFAULT}% (ค่าเริ่มต้น) ตามตาราง Cooling Capacity ${label}`, `Capacity uses combination ${COMBO_DEFAULT}% (default) from the ${label} cooling capacity table`)}${estDefault}</p>`}`;
}

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
  ['#s-wref', 'site', 'windRefH'], ['#s-gelev', 'site', 'groundElev'],
  ['#s-cell', 'sim', 'cell'], ['#s-tmax', 'sim', 'tMax'],
  ['#p-tref', 'perf', 'Tref'], ['#p-tlim', 'perf', 'Tlimit'],
];

function renderSettings() {
  for (const [sel, g, k] of SETTINGS) $(sel).value = scene[g][k];
  $('#s-grade').value = scene.sim.grade === 'uniform' ? 'uniform' : 'auto';
  renderWindProfile();
  renderStop();
  $('#p-kcap').value = round2(scene.perf.kCap * 100);
  $('#p-kpow').value = round2(scene.perf.kPow * 100);
  $('#proj-name').value = scene.name;
  $('#cond').textContent = L(`อากาศ ${scene.site.ambient} °C · ${scene.site.windSpeed > 0 ? `ลม ${scene.site.windSpeed} m/s` : 'ไม่มีลม'}`, `Ambient ${scene.site.ambient} °C · ${scene.site.windSpeed > 0 ? `wind ${scene.site.windSpeed} m/s` : 'no wind'}`);
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
  $('#s-grade').addEventListener('change', (e) => edit(() => { scene.sim.grade = e.target.value === 'uniform' ? 'uniform' : 'auto'; }));
  $('#s-wprof').addEventListener('change', (e) => edit(() => { scene.site.windProfile = WIND_PROFILES[e.target.value] ? e.target.value : 'uniform'; }));
  $('#p-kcap').addEventListener('change', (e) => edit(() => { scene.perf.kCap = Math.max(0, parseFloat(e.target.value) || 0) / 100; }));
  $('#p-kpow').addEventListener('change', (e) => edit(() => { scene.perf.kPow = Math.max(0, parseFloat(e.target.value) || 0) / 100; }));
  $('#proj-name').addEventListener('change', (e) => { scene.name = e.target.value.trim() || L('โปรเจกต์', 'Project'); saveAutosave(); });
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
      if (!isFinite(v) || !(nb.red > nb.green)) { toast(L('เกณฑ์สีแดงต้องมากกว่าเกณฑ์สีเขียว', 'The red threshold must be higher than the green one')); renderSettings(); return; }
      pushUndo();
      scene.bands = nb;
      saveAutosave();
      viewer.refreshCduColors();
      updateBandLegend();
      renderResults();
    });
  }
}

/** แผงโปรไฟล์ลม: ซ่อนช่องความสูงเมื่อเป็นลมสม่ำเสมอ และแสดงความเร็วที่ระดับต่าง ๆ ในโดเมน */
/* ───────── เงื่อนไขหยุดการคำนวณ ─────────
 * ค่าแนะนำ: ลมต้องพัดผ่านโดเมนราว 3 รอบ (ล้างสภาพเริ่มต้น) + 60 s ให้ลมร้อนสะสมและเฉลี่ยผล 20 s สุดท้าย
 *   T ≈ 60 + 3 · L / U   (L = เส้นทแยงโดเมนแนวนอน, U = ความเร็วลม หรือ 0.6 m/s เมื่อไม่มีลม — ลมพาจากแรงลอยตัว/พัดลม)
 *   จำนวนรอบ ≈ T / Δt (Δt ≈ 0.25·h จากเงื่อนไข CFL ของลมพัดลม) · เวลาจริงจากความเร็วที่วัดได้ล่าสุดหรือสูตรประมาณ */
/** Δt โดยประมาณต่อขนาดเซลล์ (s/ม.) — วัดจากตัวอย่างสำเร็จรูป: Δt ≈ 0.12·h (ลมพัดลมของ CDU กำหนด CFL) */
const DT_PER_H = 0.12;

function recommendStop(sc = scene) {
  const d = domainOf(sc);
  const L = Math.hypot(d.W, d.D);
  const U = sc.site.windSpeed > 0 ? Math.max(0.5, sc.site.windSpeed * windFactorFn(windParams(sc.site))(2)) : 0.6;
  const T = Math.min(1200, Math.max(90, Math.round((60 + 3 * L / U) / 10) * 10));
  const dt = (run.report?.dt && run.mesh && Math.abs(run.mesh.h - d.h) < 1e-9) ? run.report.dt : DT_PER_H * d.h;
  const steps = Math.ceil(T / dt / 100) * 100;
  const th = run.threads || 1;
  // ความเร็วที่วัดได้ (วินาทีจำลองต่อวินาทีจริง) ใช้เมื่อเป็นเมชเดียวกัน ไม่เช่นนั้นใช้สูตรประมาณเดียวกับหน้าตั้งค่า
  const measured = run.rate && run.mesh && Math.abs(run.mesh.h - d.h) < 1e-9 && backend === (run.report?.backend || 'cpu');
  const wallSec = measured ? T / run.rate : d.cells * 0.33e-6 * (T / dt) / Math.max(1, 0.6 * th);
  return { T, steps, dt, wallSec, wallMin: Math.max(1, Math.ceil(wallSec / 60)), L, U, measured };
}

/** เงื่อนไขหยุดที่ส่งให้ solver (ช่องที่เว้นว่าง = ค่าแนะนำ) */
function stopParams(sc = scene) {
  const s = sc.sim, rec = recommendStop(sc);
  return { mode: s.stopMode || 'converge', time: s.stopTime || rec.T, steps: s.stopSteps || rec.steps, wall: s.stopWall || rec.wallMin, early: s.stopEarly !== false };
}

function renderStop() {
  const s = scene.sim, mode = s.stopMode || 'converge', rec = recommendStop();
  $('#s-stop').value = mode;
  $('#s-conv').value = s.conv || 'standard';
  $('#s-stime').value = s.stopTime || '';
  $('#s-steps').value = s.stopSteps || '';
  $('#s-wall').value = s.stopWall || '';
  $('#s-stime').placeholder = rec.T; $('#s-steps').placeholder = rec.steps; $('#s-wall').placeholder = rec.wallMin;
  $('#s-early').checked = s.stopEarly !== false;
  $$('.stop-only').forEach(el => { el.hidden = el.classList.contains('stop-fixed') ? mode === 'converge' : el.dataset.stop !== mode; });
  const wall = fmtDur(rec.wallSec);
  $('#stop-rec').textContent = L(
    `แนะนำ: เวลาจำลอง ≈ ${rec.T} s ≈ ${rec.steps.toLocaleString()} รอบ (Δt ≈ ${rec.dt.toFixed(3)} s) · ใช้เวลาคำนวณจริง ≈ ${wall}${rec.measured ? ' (จากความเร็วที่วัดได้)' : ' (ประมาณ)'} — ลมผ่านโดเมนยาว ${fmt(rec.L)} ม. ที่ ${fmt(rec.U)} m/s ราว 3 รอบ + 60 s`,
    `Recommended: simulated time ≈ ${rec.T} s ≈ ${rec.steps.toLocaleString()} iterations (Δt ≈ ${rec.dt.toFixed(3)} s) · real computing time ≈ ${wall}${rec.measured ? ' (from the measured speed)' : ' (estimate)'} — about 3 passes of air across the ${fmt(rec.L)} m domain at ${fmt(rec.U)} m/s + 60 s`);
  $('#btn-stop-rec').hidden = mode === 'converge';
}

function bindStop() {
  $('#s-stop').addEventListener('change', (e) => edit(() => { scene.sim.stopMode = e.target.value; }, false));
  $('#s-conv').addEventListener('change', (e) => edit(() => { scene.sim.conv = e.target.value; }, false));
  for (const [id, k] of [['#s-stime', 'stopTime'], ['#s-steps', 'stopSteps'], ['#s-wall', 'stopWall']]) {
    $(id).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      edit(() => { scene.sim[k] = isFinite(v) && v > 0 ? v : 0; }, false);
    });
  }
  $('#s-early').addEventListener('change', (e) => edit(() => { scene.sim.stopEarly = e.target.checked; }, false));
  $('#btn-stop-rec').addEventListener('click', () => {
    const rec = recommendStop();
    edit(() => { scene.sim.stopTime = rec.T; scene.sim.stopSteps = rec.steps; scene.sim.stopWall = rec.wallMin; }, false);
  });
}

/** ข้อความเงื่อนไขหยุด (สั้น) */
function stopText(st) {
  if (!st || st.mode === 'converge') return L('หยุดเมื่อลู่เข้า', 'stop on convergence');
  return st.mode === 'steps' ? L(`ครบ ${Math.round(st.steps).toLocaleString()} รอบ`, `${Math.round(st.steps).toLocaleString()} iterations`)
    : st.mode === 'time' ? L(`ครบเวลาจำลอง ${Math.round(st.time)} s`, `${Math.round(st.time)} s simulated`)
      : L(`ครบเวลาคำนวณจริง ${fmt(st.wall)} นาที`, `${fmt(st.wall)} min real time`);
}

function renderWindProfile() {
  const site = scene.site, prof = WIND_PROFILES[site.windProfile] ? site.windProfile : 'uniform';
  $('#s-wprof').value = prof;
  $$('.wprof-only').forEach(el => { el.hidden = prof === 'uniform'; });
  if (prof === 'uniform') return;
  const f = windFactorFn(windParams(site)), H = domainOf(scene).H, V = site.windSpeed;
  const at = y => fmt(V * f(y));
  $('#wprof-note').textContent = V > 0
    ? L(`ความเร็วลมในโดเมน: ${at(0.5)} m/s ที่ 0.5 ม. · ${at(2)} m/s ที่ 2 ม. · ${at(H)} m/s ที่ยอดโดเมน ${fmt(H)} ม.`, `Wind in the domain: ${at(0.5)} m/s at 0.5 m · ${at(2)} m/s at 2 m · ${at(H)} m/s at the domain top ${fmt(H)} m`)
    : L('ความเร็วลม = 0 — โปรไฟล์ไม่มีผล', 'Wind speed is 0 — the profile has no effect');
}

/** ต้องมีขอบเปิดอย่างน้อยหนึ่งด้าน มิฉะนั้นความร้อนออกจากโดเมนไม่ได้และผลไม่มีวันนิ่ง */
function hasOpenFace() { return BC_FACES.some(f => scene.bc[f].type === 'open'); }

/* ───────── เครื่องคำนวณ: CPU (WebAssembly) หรือ GPU (WebGPU) ───────── */

/** ตัวเลือกของผู้ใช้ — เก็บไว้กับเบราว์เซอร์ (ขึ้นกับเครื่อง ไม่ใช่กับโปรเจกต์) */
const BACKEND_KEY = 'cfd-backend';
const gpu = { ok: false, name: '', software: false, maxBuffer: 0, reason: () => L('เบราว์เซอร์นี้ไม่มี WebGPU (ใช้ Chrome / Edge รุ่นใหม่)', 'This browser has no WebGPU (use a recent Chrome / Edge)') };
let backend = 'cpu';
try { if (localStorage.getItem(BACKEND_KEY) === 'gpu') backend = 'gpu'; } catch { /* ถูกบล็อก */ }

/** ตรวจการ์ดจอครั้งเดียวตอนเปิดโปรแกรม เพื่อบอกผู้ใช้ว่าเลือก GPU ได้หรือไม่ */
async function probeGpu() {
  try {
    if (navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (ad) {
        const i = ad.info || {};
        gpu.ok = true;
        gpu.name = [i.vendor, i.device || i.architecture, i.description].filter(Boolean).join(' ') || 'WebGPU';
        gpu.software = !!(ad.isFallbackAdapter || i.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(gpu.name));
        gpu.maxBuffer = Math.min(ad.limits.maxBufferSize, ad.limits.maxStorageBufferBindingSize);
      } else gpu.reason = () => L('ไม่พบการ์ดจอที่ใช้ WebGPU ได้ (ไดรเวอร์เก่า หรือถูกปิดในเบราว์เซอร์)', 'No WebGPU-capable graphics adapter found (old driver, or disabled in the browser)');
    }
  } catch (err) { const m = err?.message || String(err); gpu.reason = () => m; }
  if (!gpu.ok) backend = 'cpu';
  renderBackend();
  updateEstimate();
}

function renderBackend() {
  const sel = $('#s-backend');
  sel.value = backend;
  $('option[value="gpu"]', sel).disabled = !gpu.ok;
  const cores = navigator.hardwareConcurrency || 1;
  const note = $('#backend-note');
  if (backend === 'gpu') {
    note.textContent = L(`การ์ดจอ: ${gpu.name}`, `GPU: ${gpu.name}`) + (gpu.software
      ? L(' — เป็นตัวจำลองด้วยซอฟต์แวร์ ไม่ใช่การ์ดจอจริง จะช้ากว่า CPU', ' — a software emulator, not a real GPU; slower than the CPU')
      : L(' · ความแม่นยำ 32 บิต (ผลต่างจาก CPU เล็กน้อย) · ถ้าการ์ดจอใช้ไม่ได้ระหว่างเตรียมการคำนวณ จะใช้ CPU แทนอัตโนมัติ', ' · 32-bit precision (results differ slightly from CPU) · if the GPU fails while preparing, the CPU is used automatically'));
  } else {
    note.textContent = (globalThis.crossOriginIsolated
      ? L(`CPU: ใช้ได้หลายเธรด (เครื่องมี ${cores} แกน)`, `CPU: multi-threaded (this machine has ${cores} cores)`)
      : cores > 1 ? L(`CPU: ใช้ได้ 1 เธรดจาก ${cores} แกน เพราะเปิดไฟล์โดยตรง — เปิดผ่าน http:// เพื่อใช้ทุกแกน (ดูหน้า คู่มือ)`, `CPU: 1 thread of ${cores} cores because the file was opened directly — open it via http:// to use all cores (see the Guide page)`) : L('CPU: 1 เธรด', 'CPU: 1 thread'))
      + (gpu.ok ? '' : ` · GPU: ${gpu.reason()}`);
  }
}

function bindBackend() {
  $('#s-backend').addEventListener('change', (e) => {
    backend = e.target.value === 'gpu' && gpu.ok ? 'gpu' : 'cpu';
    try { localStorage.setItem(BACKEND_KEY, backend); } catch { /* ถูกบล็อก */ }
    renderBackend();
    updateEstimate();
    if (run.mesh && !run.stale && run.state !== 'idle') toast(L('เครื่องคำนวณที่เลือกจะใช้กับการคำนวณครั้งถัดไป — กด รีเซ็ตผล แล้วคำนวณใหม่', 'The selected compute device applies to the next run — press Reset results, then run again'));
  });
  renderBackend();
  probeGpu();
}

/** หน่วยความจำของ solver: CPU ≈ 75 ไบต์ต่อเซลล์ (ดู Solver.memoryBytes), GPU ≈ 112 ไบต์ต่อเซลล์บนการ์ดจอ */
const meshBytes = d => (d.nx + 2) * (d.ny + 2) * (d.nz + 2) * (backend === 'gpu' ? GPU_BYTES_PER_CELL : Solver.bytesPerCell);
/** เมชเกินขีดจำกัดของเครื่องคำนวณที่เลือกหรือไม่ — คืนข้อความอธิบาย หรือ '' */
function meshTooBig(d) {
  const N = (d.nx + 2) * (d.ny + 2) * (d.nz + 2);
  if (backend === 'gpu') {
    return gpu.maxBuffer && N * 16 > gpu.maxBuffer ? L(`เกินขนาดบัฟเฟอร์สูงสุดของการ์ดจอนี้ (${fmtMem(gpu.maxBuffer)} ต่อบัฟเฟอร์)`, `exceeds the maximum buffer size of this GPU (${fmtMem(gpu.maxBuffer)} per buffer)`) : '';
  }
  return meshBytes(d) > MAX_MESH_BYTES ? L('เกินหน่วยความจำสูงสุด 4 GB ของ WebAssembly', 'exceeds the 4 GB WebAssembly memory limit') : '';
}
/** WebAssembly 32 บิตจองได้สูงสุด 4 GiB เผื่อสแตก/ส่วนอื่นไว้ 128 MiB */
const MAX_MESH_BYTES = 4 * 1024 ** 3 - 128 * 1024 ** 2;
const fmtGB = b => (b / 1024 ** 3).toFixed(1);
/** ขนาดหน่วยความจำพร้อมหน่วย (MB เมื่อน้อยกว่า 1 GB) */
const fmtMem = b => b < 0.95 * 1024 ** 3 ? `${Math.max(1, Math.round(b / 1024 ** 2))} MB` : `${fmtGB(b)} GB`;
/** จำนวนเซลล์ที่ควรถามยืนยันก่อนคำนวณ */
const BIG_MESH = 2.5e6;

function updateEstimate() {
  const d = domainOf(scene);
  // เวลาจำลองตามเงื่อนไขหยุดที่เลือก (โหมดลู่เข้า: ค่าแนะนำ)
  const sp = stopParams();
  const steps = sp.mode === 'steps' ? sp.steps : (sp.mode === 'time' ? sp.time : recommendStop().T) / (DT_PER_H * d.h);
  // ≈0.33 µs ต่อเซลล์ต่อสเต็ปต่อเธรด; หลายเธรดเร็วขึ้นราว 0.6 เท่าของจำนวนเธรด (จำกัดด้วยความเร็วหน่วยความจำ)
  const th = run.threads || 1;
  const sec = sp.mode === 'wall' ? sp.wall * 60 : d.cells * 0.33e-6 * steps / Math.max(1, 0.6 * th);
  const el = $('#mesh-info');
  const saved = d.graded && d.cellsUniform > d.cells * 1.05
    ? L(` (เมชปรับความละเอียดอัตโนมัติ — ลดจาก ${fmtK(d.cellsUniform)} เซลล์ ${(d.cellsUniform / d.cells).toFixed(1)} เท่า · เซลล์ ${fmt(d.h)}–${fmt(d.hMax)} ม.)`, ` (adaptive mesh — down from ${fmtK(d.cellsUniform)} cells, ${(d.cellsUniform / d.cells).toFixed(1)}× fewer · cells ${fmt(d.h)}–${fmt(d.hMax)} m)`) : '';
  el.textContent = L(`โดเมน ${fmt(d.W)} × ${fmt(d.D)} × ${fmt(d.H)} ม. · กริด ${d.nx}×${d.ny}×${d.nz} = ${fmtK(d.cells)} เซลล์${saved} · หน่วยความจำ ≈ ${fmtMem(meshBytes(d))}`, `Domain ${fmt(d.W)} × ${fmt(d.D)} × ${fmt(d.H)} m · grid ${d.nx}×${d.ny}×${d.nz} = ${fmtK(d.cells)} cells${saved} · memory ≈ ${fmtMem(meshBytes(d))}`)
    + (backend === 'gpu' ? L(' (บนการ์ดจอ)', ' (on the GPU)') : '')
    + (meshTooBig(d) ? L(` — ${meshTooBig(d)} คำนวณไม่ได้ ลดระยะเผื่อโดเมนหรือเพิ่มขนาดเซลล์`, ` — ${meshTooBig(d)}; cannot run — reduce the domain margins or increase the cell size`) : '');
  el.classList.toggle('warn', d.cells > BIG_MESH);
  if (run.state !== 'running') $('#estimate').textContent = scene.objects.some(o => o.type === 'cdu')
    ? (backend === 'gpu' ? L(`${fmtK(d.cells)} เซลล์ · GPU`, `${fmtK(d.cells)} cells · GPU`) : L(`${fmtK(d.cells)} เซลล์ · ประมาณ ${fmtDur(sec)}`, `${fmtK(d.cells)} cells · about ${fmtDur(sec)}`)) : '';
}

/* ───────── การคำนวณ ───────── */

function startOrToggle() {
  if (run.state === 'running') {
    runner.send({ cmd: 'pause' });
    run.state = 'paused';
    updateRunUI();
    return;
  }
  if (run.state === 'done' && run.report?.converged && (run.report?.stop?.mode || 'converge') === 'converge' && !run.stale) {
    toast(L('ผลลู่เข้าแล้ว — แก้แบบหรือกด รีเซ็ตผล เพื่อคำนวณใหม่', 'Already converged — edit the model or press Reset results to run again'));
    return;
  }
  if ((run.state === 'paused' || run.state === 'done') && !run.stale && run.mesh) {
    run.state = 'running';
    run.lastWall = performance.now(); run.lastT = run.report?.time || 0;
    runner.send({ cmd: 'run' });
    updateRunUI();
    return;
  }
  startNewRun();
}

/** เริ่มคำนวณแบบปัจจุบันใหม่ตั้งแต่ต้น — คืน '' เมื่อเริ่มได้ หรือข้อความเหตุผลที่เริ่มไม่ได้
 *  quiet = เรียกจาก batch: ไม่ถามยืนยันเมชใหญ่ ไม่เปลี่ยนหน้า */
function startNewRun(quiet = false) {
  if (!scene.objects.some(o => o.type === 'cdu')) { if (quiet) return L('ไม่มี CDU', 'no CDU'); toast(L('ยังไม่มี CDU ในฉาก — เลือกเครื่องมือ CDU ที่แถบด้านซ้าย แล้ววางเครื่องก่อน', 'No CDU in the scene — pick the CDU tool on the left bar and place a unit first')); showTab('tool'); return 'x'; }
  if (!hasOpenFace()) { if (quiet) return L('ไม่มีขอบโดเมนแบบเปิด', 'no open boundary'); toast(L('ต้องมีขอบโดเมนแบบ "เปิด" อย่างน้อยหนึ่งด้าน ไม่เช่นนั้นลมร้อนออกไม่ได้และผลจะไม่ลู่เข้า', 'At least one domain boundary must be "Open"; otherwise hot air cannot leave and the result will not converge'), 5000); showTab('tool'); showSide('sim'); return 'x'; }
  const d = domainOf(scene);
  if (meshTooBig(d)) {
    if (quiet) return meshTooBig(d);
    toast(L(`เมชใหญ่เกินไป (${fmtK(d.cells)} เซลล์ ≈ ${fmtMem(meshBytes(d))}) ${meshTooBig(d)} — เพิ่มขนาดเซลล์ หรือลดระยะเผื่อขอบโดเมน`, `Mesh too large (${fmtK(d.cells)} cells ≈ ${fmtMem(meshBytes(d))}): ${meshTooBig(d)} — increase the cell size or reduce the domain margins`), 6000);
    return 'x';
  }
  if (!quiet && d.cells > BIG_MESH && !confirm(L(`เมช ${fmtK(d.cells)} เซลล์ อาจใช้เวลานานมากและใช้หน่วยความจำสูง คำนวณต่อหรือไม่?`, `A ${fmtK(d.cells)}-cell mesh may take very long and use a lot of memory. Continue?`))) return 'x';

  const mesh = buildMesh(scene);
  run.mesh = mesh;
  run.fields = null;
  run.report = null;
  run.stale = false;
  run.sceneJSON = JSON.stringify(scene);
  editUnlocked = false;
  run.state = 'running';
  run.startWall = run.lastWall = performance.now();
  run.lastT = 0; run.rate = null;
  viewer.setResults(null);
  runner.send({
    cmd: 'init', mesh, backend, lang: getLang(),
    params: simParams(scene),
  });
  runner.send({ cmd: 'run' });
  renderWarnings(mesh.warnings);
  if (!selected() && !quiet) showSide('view', false);   // ผลเริ่มขึ้นในภาพ → เตรียมตัวเลือกการแสดงผลไว้ให้
  updateRunUI();
  return '';
}

/** พารามิเตอร์ที่ส่งให้ solver จากฉาก */
function simParams(sc) {
  return { ambient: sc.site.ambient, windSpeed: sc.site.windSpeed, windDir: sc.site.windDir, wind: windParams(sc.site), perf: sc.perf, tMax: sc.sim.tMax, stop: stopParams(sc), convLevel: sc.sim.conv || 'standard' };
}

function resetResults() {
  runner.send({ cmd: 'dispose' });
  run.state = 'idle';
  run.mesh = null; run.report = null; run.fields = null; run.stale = false;
  editUnlocked = false;
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
    setFootMode(() => L('คำนวณบน main thread (เบราว์เซอร์ไม่อนุญาต Web Worker) — ผลเหมือนเดิมแต่หน้าจออาจหน่วงเล็กน้อย', 'Running on the main thread (the browser does not allow Web Workers) — same results, but the screen may lag slightly'));
    return;
  }
  if (msg.type === 'ready') {
    // สถานะเครื่องคำนวณที่ใช้จริง: GPU, หรือ CPU กี่เธรด (พร้อมเหตุผลถ้าใช้ได้เธรดเดียว)
    run.threads = msg.threads;
    const cores = navigator.hardwareConcurrency || 1;
    if (msg.gpuError) toast(L(`ใช้ GPU ไม่ได้ (${msg.gpuError}) — คำนวณด้วย CPU แทน`, `GPU unavailable (${msg.gpuError}) — running on the CPU instead`), 8000);
    setFootMode(() => msg.backend === 'gpu'
      ? L(`คำนวณบน GPU (WebGPU): ${msg.device}${msg.software ? ' — ตัวจำลองด้วยซอฟต์แวร์ ไม่ใช่การ์ดจอจริง' : ''}`, `Running on GPU (WebGPU): ${msg.device}${msg.software ? ' — software emulator, not a real GPU' : ''}`)
      : msg.threads > 1
        ? L(`คำนวณด้วย WebAssembly ${msg.threads} เธรด (เครื่องมี ${cores} แกน)`, `Running WebAssembly on ${msg.threads} threads (${cores} cores available)`)
        : runner.mode === 'main' ? L('คำนวณบน main thread เธรดเดียว (เบราว์เซอร์ไม่อนุญาต Web Worker)', 'Running single-threaded on the main thread (Web Workers not allowed)')
          : cores > 1 && !msg.isolated ? L(`คำนวณด้วย WebAssembly 1 เธรด — เปิดผ่าน http:// (เช่น npm run serve) เพื่อใช้ทั้ง ${cores} แกน หรือเลือกเครื่องคำนวณเป็น GPU`, `Running WebAssembly on 1 thread — open via http:// (e.g. npm run serve) to use all ${cores} cores, or switch the compute device to GPU`)
            : L('คำนวณด้วย WebAssembly 1 เธรด', 'Running WebAssembly on 1 thread'));
    return;
  }
  if (msg.type === 'error') {
    run.state = 'idle'; run.mesh = null; run.report = null; run.fields = null;
    toast(msg.message, 8000);
    renderResults();
    updateRunUI();
    if (batch.active) batchCaseFailed(msg.message);
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
    setTimeout(renderStop, 0);
    const conv = msg.reason === 'converged';
    const rp = msg.report, at = L(`t = ${rp.time.toFixed(0)} s · ${rp.steps.toLocaleString()} รอบ · ใช้เวลา ${fmtDur((rp.wall || 0) / 1000)}`, `t = ${rp.time.toFixed(0)} s · ${rp.steps.toLocaleString()} iterations · ${fmtDur((rp.wall || 0) / 1000)}`);
    toast(msg.mode && msg.mode !== 'converge'
      ? (conv ? L(`ลู่เข้าแล้ว — ${at}`, `Converged — ${at}`) : L(`ครบเงื่อนไขหยุด (${stopText(rp.stop)}) แต่ยังไม่ลู่เข้า — ${at} · กดคำนวณต่อได้`, `Stop condition reached (${stopText(rp.stop)}), not converged — ${at} · press Run to continue`))
      : (conv ? L(`ลู่เข้าแล้ว — ${at}`, `Converged — ${at}`) : L(`ถึงเพดานเวลา ${rp.time.toFixed(0)} s แต่ยังไม่ลู่เข้า — กดคำนวณต่อได้`, `Reached the ${rp.time.toFixed(0)} s time cap without converging — press Run to continue`)), 6000);
    addComparison();
  }
  renderResults();
  updateRunUI();
  if (msg.type === 'done' && batch.active) setTimeout(batchCaseDone, 0);
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
function chip(t) { return `<i class="chip chip-${band(t)}" title="${L('T ลมเข้า', 'Inlet T')} ${t.toFixed(1)} °C — ${BAND_TEXT()[band(t)].short}"></i>`; }

/** ความหมายของแต่ละแถบสีตามคำแนะนำของ Daikin */
const BAND_TEXT = () => ({
  green: { short: L('ระบายความร้อนได้', 'Rejects heat normally'), label: L('ระบายความร้อนได้ (Daikin แนะนำ)', 'Rejects heat normally (Daikin recommended)') },
  yellow: { short: L('ประสิทธิภาพลดลง', 'Reduced efficiency'), label: L('ทำงานได้ แต่ประสิทธิภาพลดลง', 'Operates, but with reduced efficiency') },
  red: { short: L('ระบายความร้อนไม่ได้', 'Cannot reject heat'), label: L('ระบายความร้อนไม่ได้ — ควรปรับการวาง', 'Cannot reject heat — change the layout') },
});

/** เกณฑ์อุณหภูมิลมกลับ (HTML) — ใช้ทั้งในหน้าผลและรายงาน */
function bandCriteriaHTML() {
  const b = scene.bands;
  return `<ul class="criteria">
    <li><i class="chip chip-green"></i>${L(`อุณหภูมิลมกลับที่ไม่เกิน ${b.green} องศาเซลเซียส คอยล์ร้อนสามารถระบายความร้อนได้ เป็นอุณหภูมิลมกลับที่ Daikin แนะนำ`, `Return-air temperature up to ${b.green} °C: the condensing unit rejects heat normally. This is the return-air temperature Daikin recommends.`)}</li>
    <li><i class="chip chip-yellow"></i>${L(`อุณหภูมิลมกลับที่อยู่ระหว่าง ${b.green}–${b.red} องศาเซลเซียส คอยล์ร้อนสามารถทำงานได้ แต่ประสิทธิภาพการทำงานของเครื่องปรับอากาศจะลดลง`, `Return-air temperature between ${b.green}–${b.red} °C: the condensing unit still operates, but the air conditioner loses efficiency.`)}</li>
    <li><i class="chip chip-red"></i>${L(`อุณหภูมิลมกลับที่เกิน ${b.red} องศาเซลเซียส คอยล์ร้อนไม่สามารถระบายความร้อนได้ ควรปรับเปลี่ยนลักษณะการวางคอยล์ร้อน`, `Return-air temperature above ${b.red} °C: the condensing unit cannot reject heat. The layout should be changed.`)}</li>
  </ul>`;
}

/** หมายเหตุท้ายผล/รายงาน */
const remarkHTML = () => L(`<p><b>REMARK :</b></p>
  <ol>
    <li>เนื่องจากการจำลองการไหลของอากาศที่เกิดขึ้น เป็นการทดลองด้วย PROGRAM COMPUTER เท่านั้น วัตถุประสงค์เพื่อใช้ในการป้องกันหรือหาแนวทางแก้ไขปัญหาเรื่องของการระบายความร้อน ซึ่งไม่ใช่สภาวะอากาศจริงที่เกิดขึ้นกับ CDU</li>
    <li>ทั้งนี้ทิศทางลมที่เข้ามาจะขึ้นอยู่กับฤดูกาล และช่วงเวลาในขณะนั้นด้วย ซึ่งจะแตกต่างกับ CFD ที่มีอยู่เพียงทิศทางเดียว ดังนั้นควรจะทำการทดลองติดตั้ง MOCK UP ROOM เพื่อตรวจสอบ ผลที่ได้จาก CFD อีกครั้ง</li>
  </ol>
  <p lang="en">Please noted that this simulation is done on the computer system that analyses the air flow pattern. A/C equipment under simulation only applicable to DAIKIN system and is not based on any actual experiments. Therefore, the simulation does not guarantee the phenomena at the actual installation site.</p>`, `<p><b>REMARK :</b></p>
  <ol>
    <li>This airflow simulation is a computer experiment only. It is intended to help prevent, or find solutions to, heat-rejection problems; it is not the actual air condition around the CDUs.</li>
    <li>Wind direction depends on the season and the time of day, whereas the CFD uses a single direction. A mock-up installation should therefore be tested to verify the CFD results.</li>
  </ol>
  <p>Please note that this simulation is done on a computer system that analyses the airflow pattern. A/C equipment under simulation is only applicable to DAIKIN systems and is not based on any actual experiments. Therefore, the simulation does not guarantee the phenomena at the actual installation site.</p>`);

/** แถบสีของเครื่อง: ใช้โมดูลที่ T ลมเข้าสูงสุด (เหมือนสีในตาราง) */
function unitBand(u) { return band(Math.max(...u.modules.map(m => m.Tin))); }

function updateBandLegend() {
  const b = scene.bands;
  const el = $('#band-legend');
  el.hidden = !run.fields || run.stale;
  if (viewer.display.cduColor === 'shade') {
    const rg = viewer.inletRange() || [scene.site.ambient, b.red];
    el.innerHTML = `<span class="muted">${L('เฉดด้านดูด = T ลมเข้า', 'Suction shading = inlet T')}</span>
      <span class="mono">${fmt(rg[0])}</span><i class="inlet-bar" style="background:${cssGradient()}"></i><span class="mono">≥ ${fmt(rg[1])} °C</span>`;
    return;
  }
  el.innerHTML = `<span class="muted">${L('สี CDU = T ลมเข้าเฉลี่ยรายโมดูล', 'CDU colour = mean inlet T per module')}</span>
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
    const kwRated = ms.reduce((s, m) => s + (m.kwRef ?? m.kw), 0);
    const kwAvail = ms.reduce((s, m) => s + (m.kwRef ?? m.kw) * m.capF, 0);
    const Tin = avg('Tin');
    const TinMax = Math.max(...ms.map(m => m.TinMax));
    const o = scene.objects.find(x => x.id === u.id);
    return {
      id: u.id, name: u.name, model: u.model, obj: o,
      combo: o && hasCapTable(o) && o.combo != null ? unitCombo(o) : null,
      kwRated, kwAvail, capF: kwAvail / kwRated, est: ms.some(m => m.est), cmm: q * 60,
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
  const setRun = (icon, label) => { $('#run-ic').setAttribute('href', `#i-${icon}`); $('#run-label').textContent = label; };
  if (run.state === 'running') setRun('pause', L('หยุด', 'Pause'));
  else if (run.state === 'paused' && !run.stale) setRun('play', L('คำนวณต่อ', 'Resume'));
  else if (run.state === 'done' && !run.stale) {
    const fixed = (r?.stop?.mode || 'converge') !== 'converge';
    if (r?.converged && !fixed) setRun('check', L('ลู่เข้าแล้ว', 'Converged'));
    else setRun('play', fixed ? L('คำนวณต่อ', 'Continue') : L('คำนวณต่อจนลู่เข้า', 'Continue to convergence'));
  }
  else setRun('play', L('คำนวณ', 'Run'));
  $('#btn-reset').hidden = !run.mesh;
  updateLockUI();

  const t = r?.time ?? 0;
  const ck = r?.checks;
  const nPass = ck ? Object.values(ck).filter(Boolean).length : 0, nAll = ck ? Object.keys(ck).length : 4;
  let text = L('พร้อมคำนวณ', 'Ready');
  if (run.stale) text = L('แบบเปลี่ยน — กดคำนวณใหม่', 'Model changed — run again');
  else if (run.state === 'running') text = t < 0.01 ? L('กำลังเตรียมเมช…', 'Building mesh…') : L('กำลังคำนวณ', 'Running');
  else if (run.state === 'paused') text = L('หยุดชั่วคราว', 'Paused');
  else if (run.state === 'done') text = r?.converged ? L('ลู่เข้าแล้ว ✓', 'Converged ✓') : (r?.stop?.mode || 'converge') !== 'converge' ? L('ครบเงื่อนไขหยุด (ยังไม่ลู่เข้า)', 'Stop condition reached (not converged)') : L('ถึงเพดานเวลา (ยังไม่ลู่เข้า)', 'Time cap reached (not converged)');
  $('#st-text').textContent = text;
  // ความคืบหน้า = เกณฑ์ลู่เข้าที่ผ่าน + จำนวนครั้งที่ผ่านต่อเนื่อง
  let prog = 0;
  const fixedStop = r?.stop && r.stop.mode !== 'converge';
  if (fixedStop) prog = Math.min(1, r.progress ?? 0);
  else if (r?.converged) prog = 1;
  else if (ck) prog = (nPass / nAll) * 0.8 + (r.hold / r.conv.hold) * 0.2;
  const target = !fixedStop ? '' : r.stop.mode === 'steps' ? ` · ${L('รอบ', 'it.')} ${r.steps.toLocaleString()}/${Math.round(r.stop.steps).toLocaleString()}`
    : r.stop.mode === 'time' ? ` / ${Math.round(r.stop.time)} s` : ` · ${fmtDur((r.wall || 0) / 1000)} / ${fmtDur(r.stop.wall * 60)}`;
  $('#st-time').textContent = r ? `t ${t.toFixed(1)} s${target} · ${L('เกณฑ์', 'checks')} ${r.converged ? nAll : nPass}/${nAll}` : 't 0.0 s';
  $('#st-bar').style.width = `${Math.min(100, prog * 100)}%`;
  if (run.state === 'running' && r) $('#estimate').textContent = isFinite(r.drift)
    ? L(`ΔT ลมเข้าเปลี่ยน ±${r.drift.toFixed(3)} °C (เป้า ≤ ${r.conv.drift})`, `Inlet T drift ±${r.drift.toFixed(3)} °C (target ≤ ${r.conv.drift})`) : L('กำลังสะสมข้อมูลเพื่อตรวจการลู่เข้า…', 'Collecting data for the convergence check…');
  else updateEstimate();

  const badge = $('#res-badge');
  badge.className = 'badge';
  if (run.stale) { badge.textContent = L('ผลเก่า (แบบถูกแก้ไข)', 'Stale results (model edited)'); badge.classList.add('stale'); }
  else if (run.state === 'running') { badge.textContent = L('กำลังคำนวณ — ผลเปลี่ยนแบบสด', 'Running — results update live'); badge.classList.add('run'); }
  else if (run.state === 'done') { badge.textContent = r?.converged ? L('ลู่เข้าแล้ว', 'Converged') : L('ยังไม่ลู่เข้า (ถึงเพดานเวลา)', 'Not converged (time cap reached)'); badge.classList.add(r?.converged ? 'ok' : 'stale'); }
  else if (run.state === 'paused') badge.textContent = L('หยุดชั่วคราว', 'Paused');
  else badge.textContent = L('ยังไม่มีผล', 'No results yet');
  $('#btn-csv').disabled = $('#btn-report').disabled = !run.report;
  // จุดสถานะบนแท็บ "ผลลัพธ์": กำลังคำนวณ / ลู่เข้าแล้ว / ผลเก่าหรือยังไม่ลู่เข้า
  const dot = $('#nav-dot');
  dot.hidden = !run.report && run.state !== 'running';
  dot.className = 'dot ' + (run.stale ? 'stale' : run.state === 'running' ? 'run' : run.state === 'done' ? (r?.converged ? 'ok' : 'stale') : '');
  dot.title = badge.textContent;
}

function renderResults() {
  const units = unitsNow();
  const tb = $('#res-table tbody');
  $('#res-table').classList.toggle('stale-table', run.stale);
  const sum = $('#st-sum');
  sum.hidden = !units;
  $('#results').classList.toggle('empty', !units);
  if (!units) {
    tb.innerHTML = `<tr><td colspan="13" class="muted">${L('ยังไม่มีผล — กด คำนวณ มุมขวาบน', 'No results yet — press Run at the top right')}</td></tr>`;
    $('#kpis').innerHTML = '';
    $('#quality').innerHTML = `<div class="q">${L('ยังไม่มีผล', 'No results yet')}</div><div class="v">–</div>`;
    $('#advice').innerHTML = `<li class="muted">${L('กด คำนวณ เพื่อดูผล', 'Press Run to see results')}</li>`;
    $('#criteria').innerHTML = bandCriteriaHTML();
    drawChart(null);
    drawResiduals();
    return;
  }
  const rows = [];
  for (const u of units) {
    rows.push(`<tr data-id="${u.id}" class="${u.id === selectedId ? 'sel' : ''}">
      <td><b>${esc(u.name)}</b></td><td>${esc(u.model)}${u.combo != null ? ` <span class="muted">· ${u.combo}%</span>` : ''}</td><td class="n">${u.kwRated.toFixed(1)}</td><td class="n">${u.cmm.toFixed(0)}</td>
      <td class="n">${chip(Math.max(...u.modules.map(m => m.Tin)))}${u.Tin.toFixed(2)}</td><td class="n">${u.TinMax.toFixed(1)}</td><td class="n st-${u.status.key}">+${u.dT.toFixed(2)}</td>
      <td class="n">${(u.Cin * 100).toFixed(1)}</td><td class="n">${u.Tdis.toFixed(1)}</td><td class="n">${(u.capF * 100).toFixed(1)}${estTag(u.est)}</td>
      <td class="n">${u.kwAvail.toFixed(1)}</td><td class="n">${u.blockedPct.toFixed(0)}</td>
      <td><span class="pill st-${u.status.key}">${u.status.short}</span></td></tr>`);
    if (u.modules.length > 1) for (const m of u.modules) {
      rows.push(`<tr class="sub" data-id="${u.id}"><td>${L('โมดูล', 'Module')} ${m.hp} HP</td><td></td><td class="n">${m.kw.toFixed(1)}</td><td class="n">${(m.q * 60).toFixed(0)}</td>
        <td class="n">${chip(m.Tin)}${m.Tin.toFixed(2)}</td><td class="n">${m.TinMax.toFixed(1)}</td><td class="n">+${(m.Tin - scene.site.ambient).toFixed(2)}</td>
        <td class="n">${(m.Cin * 100).toFixed(1)}</td><td class="n">${m.Tdis.toFixed(1)}</td><td class="n">${(m.capF * 100).toFixed(1)}${estTag(m.est)}</td>
        <td class="n">${((m.kwRef ?? m.kw) * m.capF).toFixed(1)}</td><td class="n">${m.blockedPct.toFixed(0)}</td><td></td></tr>`);
    }
  }
  if (units.some(u => u.est)) rows.push(`<tr class="est-row"><td colspan="13">(Estimate) = ${EST_TEXT()} — ${L('T ลมเข้าเกินช่วงตาราง Cooling Capacity', 'inlet T beyond the cooling capacity table')}</td></tr>`);
  tb.innerHTML = rows.join('');
  $('#criteria').innerHTML = bandCriteriaHTML();
  $$('tr[data-id]', tb).forEach(tr => tr.addEventListener('click', () => select(Number(tr.dataset.id))));

  // ตัวเลขสรุป
  const worst = units.reduce((a, b) => (b.dT > a.dT ? b : a));
  const kwR = units.reduce((s, u) => s + u.kwRated, 0), kwA = units.reduce((s, u) => s + u.kwAvail, 0);
  const avgDT = units.reduce((s, u) => s + u.dT * u.cmm, 0) / units.reduce((s, u) => s + u.cmm, 0);
  const nIssue = units.filter(u => u.status.key !== 'ok').length;
  sum.classList.toggle('stale', run.stale);
  sum.innerHTML = `<span>${L(L('ΔT สูงสุด', 'Max ΔT'), 'Max ΔT')} <b class="st-${worst.status.key}">+${worst.dT.toFixed(2)} °C</b> · ${esc(worst.name)}${run.stale ? L(' (ผลเก่า)', ' (stale)') : ''}</span><span class="go">${L('ดูผลลัพธ์', 'View results')} →</span>`;
  $('#kpis').innerHTML = [
    kpi(L('ΔT สูงสุด', 'Max ΔT'), `+${worst.dT.toFixed(2)} °C`, `${esc(worst.name)} · ${L('T ลมเข้า', 'inlet T')} ${worst.Tin.toFixed(1)} °C`, worst.status.key),
    kpi(L('ΔT เฉลี่ย (ถ่วงอัตราลม)', 'Mean ΔT (airflow-weighted)'), `+${avgDT.toFixed(2)} °C`, L(`อากาศภายนอก ${scene.site.ambient} °C`, `ambient ${scene.site.ambient} °C`)),
    kpi(L('Capacity รวม', 'Total capacity'), `${(kwA / kwR * 100).toFixed(1)}%`, L(`${kwA.toFixed(1)} จาก ${kwR.toFixed(1)} kW (หาย ${(kwR - kwA).toFixed(1)} kW)`, `${kwA.toFixed(1)} of ${kwR.toFixed(1)} kW (${(kwR - kwA).toFixed(1)} kW lost)`)),
    kpi(L('เครื่องที่ต้องดูแล', 'Units needing attention'), `${nIssue} / ${units.length}`, nIssue ? 'ΔT ≥ 1 °C' : L('ทุกเครื่อง ΔT < 1 °C', 'All units ΔT < 1 °C'), nIssue ? 'watch' : 'ok'),
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
  q.push([L('กริด', 'Grid'), `${M.nx}×${M.ny}×${M.nz} · h = ${M.h}${M.graded ? '–' + fmt(M.hMax) : ''} ${L('ม.', 'm')}${M.graded ? L(' (ปรับความละเอียดอัตโนมัติ)', ' (adaptive)') : ''}`]);
  q.push([L('เครื่องคำนวณ', 'Compute device'), r.backend === 'gpu' ? `GPU · ${esc(r.device || 'WebGPU')} · ${L('เลข 32 บิต', '32-bit floats')}` : `CPU · WebAssembly · ${r.threads || 1} ${L('เธรด', 'thread(s)')}`]);
  q.push([L('เซลล์อากาศ / louver', 'Air / louver cells'), `${fmtK(M.stats.fluid)} / ${fmtK(M.stats.porous)}`]);
  q.push([L('เวลาจำลอง · สเต็ป', 'Simulated time · steps'), `${r.time.toFixed(1)} s · ${r.steps}`]);
  q.push(['Δt', `${(r.dt * 1000).toFixed(0)} ms`]);
  q.push([L('รอบ Poisson ต่อสเต็ป', 'Poisson iterations per step'), `${r.pIters}`]);
  // เกณฑ์ลู่เข้า — ต้องผ่านทุกข้อต่อเนื่องกัน
  const C = r.conv, ck = r.checks || {};
  const mark = (ok) => ok ? '✓ ' : '✗ ';
  const bal = r.balance.ratio;
  q.push([L('เงื่อนไขหยุด', 'Stop condition'), `${stopText(r.stop)} · ${L('เดินไป', 'ran')} ${r.steps.toLocaleString()} ${L('รอบ', 'iterations')} · ${fmtDur((r.wall || 0) / 1000)}`]);
  q.push([L('<b>เกณฑ์ลู่เข้า</b>', '<b>Convergence criteria</b>'), r.converged ? L('<b>ผ่านครบ ✓</b>', '<b>All passed ✓</b>') : L(`ผ่านต่อเนื่อง ${r.hold}/${C.hold} ครั้ง`, `${r.hold}/${C.hold} consecutive passes`), r.converged ? 'good' : '']);
  q.push([`${mark(ck.time)}${L('เวลาจำลอง', 'Simulated time')} ≥ ${C.tMin} s`, `${r.time.toFixed(1)} s`, cls(ck.time)]);
  q.push([`${mark(ck.drift)}${L('T ลมเข้าเปลี่ยน', 'Inlet T drift')} ≤ ±${C.drift} °C`, isFinite(r.drift) ? `±${r.drift.toFixed(3)} °C` : L('รอข้อมูล 20 s', 'waiting for 20 s of data'), cls(ck.drift)]);
  q.push([`${mark(ck.balance)}${L('สมดุลพลังงาน', 'Energy balance')} ${C.balLo * 100}–${C.balHi * 100}%`, isFinite(bal) ? `${(bal * 100).toFixed(1)}%` : '–', cls(ck.balance)]);
  q.push([`${mark(ck.mass)}${L('ความคลาดเคลื่อนมวล', 'Mass error')} ≤ ${C.mass * 100}%`, `${(r.divErr * 100).toFixed(2)}%`, cls(ck.mass)]);
  q.push([L('ความร้อนจาก CDU', 'Heat from CDUs'), `${(r.balance.qIn / 1000).toFixed(1)} kW`]);
  const bcName = { open: L('เปิด', 'Open'), wall: L('ผนัง', 'Wall'), symmetry: L('สมมาตร', 'Symmetry') };
  q.push([L('ขอบ X− / X+ / Z− / Z+ / บน', 'Boundaries X− / X+ / Z− / Z+ / top'), ['xmin', 'xmax', 'zmin', 'zmax', 'ymax'].map(f => bcName[M.bc[f].type]).join(' / ')]);
  const fa = M.modules.filter(m => m.active);
  const ratio = fa.reduce((s, m) => s + m.fanAreaGrid, 0) / Math.max(1e-6, fa.reduce((s, m) => s + m.fanAreaReal, 0));
  q.push([L('พื้นที่พัดลมบนกริด / จริง', 'Fan area on grid / actual'), `${(ratio * 100).toFixed(0)}%`, cls(ratio > 0.6 && ratio < 1.6)]);
  q.push([L('ค่าเฉลี่ยผลช่วงสุดท้าย', 'Averaging window'), `${r.avgWindow.toFixed(0)} s`]);
  if (run.rate) q.push([L('ความเร็วคำนวณ', 'Compute speed'), `${run.rate.toFixed(2)} ${L('s จำลอง / วินาที', 'simulated s per second')}`]);
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
    const frontUnit = getModel(o.model).discharge === 'front';
    const top = (o.elev || 0) + unitSize(o).h + (frontUnit ? 0 : (o.duct || 0));
    const tips = [];
    if (u.TinMax >= perf.Tlimit || u.Tin >= perf.Tlimit) tips.push(L(`<b>เสี่ยงตัดการทำงาน</b> — จุดร้อนหน้าคอยล์ ${u.TinMax.toFixed(1)} °C ถึงขีดจำกัด ${perf.Tlimit} °C`, `<b>Trip risk</b> — coil hot spot ${u.TinMax.toFixed(1)} °C reaches the ${perf.Tlimit} °C limit`));
    const near = walls.filter(w => distToSeg(o.x, o.z, w) < 4);
    const tall = near.filter(w => (w.gap || 0) + w.height > top - 0.1);
    if (frontUnit) {
      if ((!o.deflect || o.deflect === 'none') && (tall.length || u.Cin > 0.1)) tips.push(L('ติดใบเบี่ยงลม: ตั้งทิศทางลมร้อนเบี่ยง 45° ขึ้นหรือไปทางที่โล่ง ให้ลมร้อนพ้นผนัง/เครื่องข้างเคียง', 'Fit a deflector: aim the discharge 45° upward or towards open space so the hot air clears walls and neighbouring units'));
    } else if (!(o.duct > 0) && (tall.length || u.Cin > 0.1)) tips.push(L(`ติด Hood ให้ปากลมสูงกว่า${tall.length ? 'ผนังรอบข้าง' : 'เดิม'} ≥ 0.5–1 ม. — ใต้หลังคา/ชายคาใช้ Hood ท่อโค้ง 90° ยื่นออกทางด้านที่โล่ง`, `Fit a hood so the outlet is ≥ 0.5–1 m higher than ${tall.length ? 'the surrounding walls' : 'it is now'} — under a roof/eave use a 90° elbow hood towards the open side`));
    const lowLouver = near.filter(w => w.louver > 0 && w.louver < 60);
    if (lowLouver.length) tips.push(L(`เพิ่มพื้นที่เปิดของ ${lowLouver.map(w => esc(w.name)).join(', ')} (ตอนนี้ ${lowLouver.map(w => w.louver + '%').join(', ')})`, `Increase the open area of ${lowLouver.map(w => esc(w.name)).join(', ')} (now ${lowLouver.map(w => w.louver + '%').join(', ')})`));
    const solidNear = near.filter(w => !(w.louver > 0));
    if (solidNear.length) tips.push(L(`ผนังทึบใกล้เครื่อง (${solidNear.map(w => esc(w.name)).join(', ')}) — เปลี่ยนเป็น louver หรือเว้นระยะมากขึ้น`, `Solid wall near the unit (${solidNear.map(w => esc(w.name)).join(', ')}) — change it to a louver or increase the clearance`));
    if (u.blockedPct > 20) tips.push(L(`หน้าคอยล์ถูกบัง ${u.blockedPct.toFixed(0)}% — เพิ่มระยะจากผนัง/เครื่องข้างเคียง`, `Coil face ${u.blockedPct.toFixed(0)}% blocked — increase the distance from walls/neighbouring units`));
    if (!tips.length) tips.push(L('ขยับให้ห่างจากเครื่องที่อยู่ต้นลม หรือเพิ่มระยะระหว่างแถว', 'Move it away from upwind units, or increase the row spacing'));
    out.push(`<li><b class="st-${u.status.key}">${esc(u.name)}</b> ΔT +${u.dT.toFixed(2)} °C · ${L('ลมวนกลับ', 'recirculation')} ${(u.Cin * 100).toFixed(1)}%<span class="adv-cap"> · capacity ${(u.capF * 100).toFixed(1)}%${u.est ? ` (${EST_TEXT()})` : ''}</span>
      <br>${tips.map(t => '→ ' + t).join('<br>')}</li>`);
  }
  if (!out.length) out.push(L('<li><b class="st-ok">ทุกเครื่อง ΔT &lt; 1 °C</b> — ลมร้อนวนกลับน้อย ผังนี้ใช้ได้ในเงื่อนไขที่ตั้งไว้</li>', '<li><b class="st-ok">All units ΔT &lt; 1 °C</b> — little recirculation; this layout works under the set conditions</li>'));
  const r = run.report;
  if (run.mesh.h >= 0.45) out.push(L('<li class="muted">ผลจากเมชหยาบ (0.5 ม.) ใช้ร่างผังเท่านั้น — ยืนยันด้วยเซลล์ 0.25–0.35 ม.</li>', '<li class="muted">Results from a coarse mesh (0.5 m) are for sketching only — confirm with 0.25–0.35 m cells</li>'));
  if (run.state === 'done' && !r.converged) out.push((r.stop?.mode || 'converge') !== 'converge'
    ? L(`<li class="muted">หยุดตามเงื่อนไข (${stopText(r.stop)}) ก่อนผลลู่เข้า — ตัวเลขเป็นค่าเฉลี่ย ${r.avgWindow.toFixed(0)} s สุดท้าย อาจยังเปลี่ยนได้อีก · กด "คำนวณต่อ" เพื่อเดินต่ออีกเท่าเดิม</li>`, `<li class="muted">Stopped by the set condition (${stopText(r.stop)}) before converging — figures are the mean of the last ${r.avgWindow.toFixed(0)} s and may still change · press "Continue" to run the same amount again</li>`)
    : L('<li class="muted">ถึงเพดานเวลาแต่ยังไม่ลู่เข้า — กด "คำนวณต่อจนลู่เข้า" ลดเกณฑ์ลู่เข้าเป็น "มาตรฐาน" / "เร็ว" หรือเพิ่มเพดานเวลาในหัวข้อขั้นสูง</li>', '<li class="muted">Time cap reached without converging — press "Continue to convergence", use the "Standard" / "Fast" convergence criterion, or raise the time cap under Advanced</li>'));
  if (!(scene.site.windSpeed > 0)) out.push(L('<li class="muted">คำนวณแบบไม่มีลม (มักเป็นกรณีแย่ที่สุด) — ลองใส่ลม 1–3 m/s จากทิศที่พบบ่อยเพื่อเทียบ</li>', '<li class="muted">No-wind case (usually the worst) — try 1–3 m/s from the prevailing direction for comparison</li>'));
  $('#advice').innerHTML = out.join('');
}

function renderWarnings(ws) {
  if (ws && ws.length) toast(ws.slice(0, 3).join(' · '), 6000);
}

/* กราฟ T ลมเข้าตามเวลา */
const PALETTE = ['#4fc3f7', '#f2c14e', '#ef6f6c', '#7bd389', '#b692f6', '#f59e42', '#5eead4', '#f472b6', '#a3e635', '#93c5fd', '#fca5a5', '#fde68a'];

function drawChart(units) {
  const cv = $('#chart');
  if (!cv.clientWidth) return;   // หน้าผลลัพธ์ถูกซ่อนอยู่ — วาดเมื่อเปิดหน้า (showTab)
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 220;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  const r = run.report;
  if (!units || !r || !r.history.t.length) {
    x.fillStyle = cssVar('--muted'); x.font = '13px sans-serif';
    x.fillText(L('กราฟจะแสดงระหว่างคำนวณ', 'The chart appears during the run'), 14, 26);
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
  x.strokeStyle = cssVar('--line-2'); x.fillStyle = cssVar('--muted'); x.font = '11px "IBM Plex Mono", monospace'; x.lineWidth = 1;
  const stepY = (hi - lo) > 6 ? 2 : (hi - lo) > 2.5 ? 1 : 0.5;
  for (let v = lo; v <= hi + 1e-6; v += stepY) {
    x.beginPath(); x.moveTo(pl, Y(v)); x.lineTo(W - pr, Y(v)); x.stroke();
    x.fillText(v.toFixed(1), 4, Y(v) + 4);
  }
  const t0 = t[0], t1 = t[t.length - 1], stepX = t1 - t0 > 400 ? 120 : t1 - t0 > 120 ? 30 : t1 - t0 > 40 ? 10 : 5;
  for (let v = Math.ceil(t0 / stepX) * stepX; v <= t1; v += stepX) x.fillText(`${v}s`, X(v) - 8, H - pb + 14);
  // เส้นอากาศภายนอก
  x.setLineDash([4, 4]); x.strokeStyle = cssVar('--muted');
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
    x.fillStyle = cssVar('--text-2'); x.fillText(s.name, lx + 16, ly - 3);
    lx += w;
  }
  $('#chart-note').textContent = L(`เส้นประ = อากาศภายนอก ${amb} °C`, `dashed = ambient ${amb} °C`);
}

/* กราฟ residual (สเกล log) แบบ CFX */
function drawResiduals() {
  const cv = $('#chart-res');
  if (!cv.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 220;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  const r = run.report;
  const h = r?.history;
  if (!h || h.t.length < 2) {
    x.fillStyle = cssVar('--muted'); x.font = '13px sans-serif';
    x.fillText(L('กราฟ residual จะแสดงระหว่างคำนวณ', 'The residual chart appears during the run'), 14, 26);
    return;
  }
  const series = [
    { name: L('มวล (continuity)', 'Mass (continuity)'), color: '#4fc3f7', ys: h.res.mass },
    { name: L('โมเมนตัม', 'Momentum'), color: '#f2c14e', ys: h.res.mom },
    { name: L('พลังงาน', 'Energy'), color: '#ef6f6c', ys: h.res.energy },
  ];
  const lo = -8, hi = 0;   // log10
  const pl = 42, pr = 10, pt = 10, pb = 44;
  const t = h.t;
  const X = v => pl + (v - t[0]) / Math.max(1e-6, t[t.length - 1] - t[0]) * (W - pl - pr);
  const Y = v => pt + (1 - (Math.log10(Math.max(1e-8, v)) - lo) / (hi - lo)) * (H - pt - pb);
  x.strokeStyle = cssVar('--line-2'); x.fillStyle = cssVar('--muted'); x.font = '11px "IBM Plex Mono", monospace'; x.lineWidth = 1;
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
    x.fillStyle = cssVar('--text-2'); x.fillText(s.name, lx + 16, H - 15);
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
  if (!compare.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">${L('ยังไม่มี', 'None yet')}</td></tr>`; return; }
  tb.innerHTML = compare.map((c, i) => `<tr>
    <td>${i + 1}. ${esc(c.name)}${c.converged ? '' : ` <span class="muted small">(${L('ยังไม่นิ่ง', 'not settled')})</span>`}</td>
    <td class="n">${c.h}</td><td class="n">+${c.maxDT.toFixed(2)}</td><td class="n">+${c.avgDT.toFixed(2)}</td>
    <td class="n">${(c.cap * 100).toFixed(1)}%</td><td><button data-i="${i}" title="${L('เปิดแบบของทางเลือกนี้', 'Open the model of this option')}">${L('เปิด', 'Open')}</button></td></tr>`).join('');
  $$('button', tb).forEach(b => b.addEventListener('click', () => {
    const c = compare[Number(b.dataset.i)];
    edit(() => { scene = normalizeScene(JSON.parse(c.sceneJSON)); }, true, true);
    toast(L(`เปิดแบบ "${c.name}" — กดคำนวณเพื่อดูผลอีกครั้ง`, `Opened "${c.name}" — press Run to see the results again`));
  }));
}

/* ───────── ระนาบหน้าตัด / แถบสี / หัววัด ───────── */

function syncSectionUI(pos) {
  const s = viewer.section;
  if (pos != null) s.pos = pos;
  const [a, b] = viewer.sectionLimits();
  $('#d-pos').value = (s.pos - a) / Math.max(1e-6, b - a);
  $('#d-pos-val').textContent = `${s.axis} = ${s.pos.toFixed(2)} ${L('ม.', 'm')}`;
  $$('#d-axis button').forEach(btn => btn.classList.toggle('on', btn.dataset.v === s.axis));
  const name = s.axis === 'y' ? L(`ระนาบนอน ที่ความสูง y = ${s.pos.toFixed(2)} m`, `Horizontal plane at height y = ${s.pos.toFixed(2)} m`) : L(`หน้าตัดตั้งฉากแกน ${s.axis.toUpperCase()} ที่ ${s.axis} = ${s.pos.toFixed(2)} m`, `Section normal to ${s.axis.toUpperCase()} at ${s.axis} = ${s.pos.toFixed(2)} m`);
  $('#sec-info').textContent = name;
}

function updatePlayButton(on = viewer.display.playing) {
  const b = $('#btn-play');
  b.disabled = !run.fields || run.stale;
  b.classList.toggle('on', on);
  $('#play-ic').setAttribute('href', on ? '#i-pause' : '#i-play');
  $('#play-label').textContent = on ? L('หยุดภาพเคลื่อนไหว', 'Stop animation') : L('เล่นภาพเคลื่อนไหว', 'Play animation');
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
  const f = FIELDS[viewer.display.field];
  $('#cbar-title').textContent = `${f.label} (${f.unit}) · ${MODE_NAME[viewer.display.mode]}`;
  $('#cbar').style.background = cssGradient(viewer.display.mode === 'contour' ? CONTOUR_LEVELS : 0);
  const lab = $('#cbar-labels');
  const ticks = colorbarTicks();
  if (!ticks) {
    lab.innerHTML = `<span style="left:0">${scene.site.ambient} °C (ambient)</span><span style="left:100%">${L('คำนวณเพื่อดูสเกล', 'run to see the scale')}</span>`;
    return;
  }
  lab.innerHTML = ticks.map(t => `<span style="left:${t.p * 100}%">${t.txt}</span>`).join('');
}

/* ───────── Capture ภาพหลายมุมสำหรับรายงาน ───────── */

const captures = [];   // { url, caption }
const VIEW_NAME = () => L({ '3d': 'มุมมอง 3D', n: '3D จากทิศเหนือ', s: '3D จากทิศใต้', e: '3D จากทิศตะวันออก', w: '3D จากทิศตะวันตก', top: 'มุมมองด้านบน (Top)', iso: 'มุมมอง Isometric', px: 'มุมมอง +X', nx: 'มุมมอง −X', py: 'มุมมองด้านบน (Top)', ny: 'มุมมอง −Y (ล่าง)', pz: 'มุมมอง +Z', nz: 'มุมมอง −Z' },
  { '3d': '3D view', n: '3D from north', s: '3D from south', e: '3D from east', w: '3D from west', top: 'Top view', iso: 'Isometric view', px: 'View +X', nx: 'View −X', py: 'Top view', ny: 'View −Y (below)', pz: 'View +Z', nz: 'View −Z' });
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
  const sec = viewer.section.show ? L(` · หน้าตัด ${viewer.section.axis.toUpperCase()} = ${viewer.section.pos.toFixed(2)} ม.`, ` · section ${viewer.section.axis.toUpperCase()} = ${viewer.section.pos.toFixed(2)} m`) : '';
  return `${scene.name} — ${VIEW_NAME()[viewer.view] || viewer.view}${run.fields ? ` · ${f.label}${sec}` : ''}`;
}

async function captureView() {
  const url = await composeCapture(captionNow());
  captures.push({ url, caption: captionNow() });
  const fl = document.createElement('div');
  fl.className = 'capture-flash';
  $('#viewport').appendChild(fl);
  requestAnimationFrame(() => { fl.style.opacity = '0'; setTimeout(() => fl.remove(), 400); });
  renderCaptures();
  toast(L(`บันทึกภาพที่ ${captures.length} แล้ว — ดูได้ที่หน้า ผลลัพธ์ และอยู่ในรายงาน HTML`, `Image ${captures.length} saved — see it on the Results page and in the HTML report`));
}

function renderCaptures() {
  $('#cap-count').textContent = `(${captures.length})`;
  $('#btn-cap-all').disabled = $('#btn-cap-clear').disabled = !captures.length;
  const box = $('#cap-list');
  if (!captures.length) {
    box.innerHTML = `<p class="muted small" style="margin:0">${L('กดปุ่ม <b>Capture</b> (รูปกล้อง) บนภาพ 3D หรือคีย์ <kbd>P</kbd> เพื่อเก็บภาพหลายมุม (หมุน/เลือกแกน/เลื่อนหน้าตัดก่อนกด)', 'Press <b>Capture</b> (camera icon) on the 3D view, or the <kbd>P</kbd> key, to collect several views (rotate / pick an axis / move the section first)')}
      ${L('— ทุกภาพจะอยู่ในรายงาน HTML ตามลำดับ แก้คำบรรยายใต้ภาพได้', '— every image goes into the HTML report in order; captions are editable')}</p>`;
    return;
  }
  box.innerHTML = captures.map((c, i) => `<div class="cap-item" data-i="${i}">
    <img src="${c.url}" alt="${L('ภาพที่', 'Image')} ${i + 1}" title="${L('คลิกเพื่อเปิดภาพเต็ม', 'Click to open the full image')}">
    <input type="text" value="${esc(c.caption)}" title="${L('คำบรรยายใต้ภาพในรายงาน', 'Caption shown under the image in the report')}">
    <div class="cap-row"><span class="muted">${L('ภาพที่', 'Image')} ${i + 1}</span><span>
      <button class="ghost" data-a="up" ${i ? '' : 'disabled'} title="${L('เลื่อนขึ้น', 'Move up')}">↑</button>
      <button class="ghost" data-a="dl" title="${L('ดาวน์โหลด PNG', 'Download PNG')}">⬇</button>
      <button class="ghost danger" data-a="del" title="${L('ลบ', 'Delete')}">✕</button></span></div></div>`).join('');
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

/** เต็มจอทั้งโปรแกรม (แถบบน + เครื่องมือ + ภาพ + แผงแก้วัตถุ) เพื่อให้แก้โมเดลและคำนวณต่อได้ */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => toast(L('เบราว์เซอร์ไม่อนุญาตโหมดเต็มจอ', 'The browser does not allow fullscreen')));
}

/** ค่าที่จุดใต้เมาส์บนระนาบหน้าตัด — แสดงที่แถบสถานะด้านล่างแทนคำแนะนำการใช้เมาส์ */
function showProbe(info) {
  const el = $('#probe');
  el.hidden = !info;
  $('#hint').hidden = !!info;
  if (!info) return;
  const p = info.p;
  const at = `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
  if (info.solid) { el.textContent = L(`จุดบนระนาบ ${at}: ของแข็ง`, `Point on plane ${at}: solid`); return; }
  const P = info.P == null ? '' : ` · P ${info.P >= 0 ? '+' : ''}${info.P.toFixed(2)} Pa`;
  el.textContent = L(`จุดบนระนาบ ${at}: T ${info.T.toFixed(2)} °C · ΔT +${(info.T - scene.site.ambient).toFixed(2)} °C · |V| ${info.V.toFixed(2)} m/s${P} · ลมจาก CDU ${(info.C * 100).toFixed(0)}%`, `Point on plane ${at}: T ${info.T.toFixed(2)} °C · ΔT +${(info.T - scene.site.ambient).toFixed(2)} °C · |V| ${info.V.toFixed(2)} m/s${P} · CDU air ${(info.C * 100).toFixed(0)}%`);
}

/* ───────── ไฟล์ / ส่งออก ───────── */

function saveProject() {
  // แบบ DXF ฉากหลังเก็บไว้ในไฟล์โปรเจกต์ด้วย (ฟิลด์ underlay — ไม่อยู่ในฉากที่ใช้คำนวณ)
  const out = underlay ? { ...scene, underlay } : scene;
  download(`${safeName(scene.name)}.json`, JSON.stringify(out, null, underlay ? 0 : 2), 'application/json');
}

function openProject(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const raw = JSON.parse(rd.result);
      const s = normalizeScene(raw);
      edit(() => { scene = s; selectedId = null; }, true, true);
      setUnderlay(raw.underlay?.layers ? raw.underlay : null);
      showTab('tool');
      viewer.setView(viewer.view);
      initSection();
      toast(L(`เปิด "${s.name}" แล้ว`, `Opened "${s.name}"`));
    } catch (e) { toast(L('เปิดไฟล์ไม่ได้: ', 'Cannot open the file: ') + e.message); }
  };
  rd.readAsText(file);
}

function exportCSV() {
  const units = unitsNow();
  if (!units) return;
  const head = L(['CDU', 'รุ่น', 'kW พิกัด', 'อัตราลม m3/min', 'T ลมเข้าเฉลี่ย C', 'T ลมเข้าสูงสุด C', 'dT C', 'ลมวนกลับ %', 'T ลมเป่า C', 'Capacity %', 'kW ที่ได้', 'คอยล์ถูกบัง %', 'สถานะ', 'เกณฑ์ T ลมกลับ'],
    ['CDU', 'Model', 'Rated kW', 'Airflow m3/min', 'Mean inlet T C', 'Max inlet T C', 'dT C', 'Recirculation %', 'Discharge T C', 'Capacity %', 'Available kW', 'Coil blocked %', 'Status', 'Return-air criterion']);
  const rows = units.map(u => [u.name, u.model, u.kwRated.toFixed(1), u.cmm.toFixed(0), u.Tin.toFixed(2), u.TinMax.toFixed(2), u.dT.toFixed(2),
    (u.Cin * 100).toFixed(1), u.Tdis.toFixed(1), (u.capF * 100).toFixed(1) + (u.est ? ` (${EST_TEXT()})` : ''), u.kwAvail.toFixed(1), u.blockedPct.toFixed(0), u.status.label, BAND_TEXT()[unitBand(u)].label]);
  const csv = '﻿' + [head, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`${safeName(scene.name)}-results.csv`, csv, 'text/csv');
}

/* ───────── ตัวเลือกรายงาน: เลือกคอลัมน์/หัวข้อที่จะแสดง ─────────
 * Capacity ซ่อนไว้เป็นค่าเริ่มต้น — เป็นค่าประมาณจากแบบจำลอง ไม่ใช่ Capacity จริงของเครื่อง */
const REPORT_KEY = 'cdu-cfd-report-opts';
const REPORT_COLS = () => [
  { k: 'name', th: 'CDU', td: u => `<td>${esc(u.name)}</td>` },
  { k: 'model', th: L('รุ่น', 'Model'), td: u => `<td>${esc(u.model)}</td>` },
  { k: 'kw', th: L('kW พิกัด', 'Rated kW'), td: u => `<td class="n">${u.kwRated.toFixed(1)}</td>` },
  { k: 'cmm', th: L('ลม m³/min', 'Airflow m³/min'), td: u => `<td class="n">${u.cmm.toFixed(0)}</td>` },
  { k: 'tin', th: L('T ลมเข้า °C', 'Inlet T °C'), td: u => `<td class="n">${u.Tin.toFixed(2)}</td>` },
  { k: 'tmax', th: L('สูงสุด °C', 'Max °C'), td: u => `<td class="n">${u.TinMax.toFixed(1)}</td>` },
  { k: 'dt', th: 'ΔT °C', td: u => `<td class="n">+${u.dT.toFixed(2)}</td>` },
  { k: 'recirc', th: L('ลมวนกลับ %', 'Recirc. %'), td: u => `<td class="n">${(u.Cin * 100).toFixed(1)}</td>` },
  { k: 'cap', th: 'Capacity %', td: u => `<td class="n">${(u.capF * 100).toFixed(1)}${u.est ? ` (${EST_TEXT()})` : ''}</td>`, off: true },
  { k: 'kwa', th: L('kW ที่ได้', 'Available kW'), td: u => `<td class="n">${u.kwAvail.toFixed(1)}</td>`, off: true },
  { k: 'status', th: L('สถานะ', 'Status'), td: u => `<td class="${u.status.key}">${u.status.label}</td>` },
  { k: 'band', th: L('เกณฑ์ T ลมกลับ', 'Return-air criterion'), td: u => `<td><i class="chip chip-${unitBand(u)}"></i>${BAND_TEXT()[unitBand(u)].label}</td>` },
];
const REPORT_SECS = () => [
  { k: 'figs', label: L('ภาพที่ Capture', 'Captured images') },
  { k: 'criteria', label: L('เกณฑ์อุณหภูมิลมกลับ', 'Return-air criteria') },
  { k: 'advice', label: L('ข้อสังเกต', 'Observations') },
  { k: 'remark', label: L('หมายเหตุท้ายรายงาน', 'Closing remark') },
];
function defaultRepOpts() {
  return {
    cols: Object.fromEntries(REPORT_COLS().map(c => [c.k, !c.off])),
    secs: Object.fromEntries(REPORT_SECS().map(c => [c.k, true])),
  };
}
let repOpts = defaultRepOpts();
try {
  const v = JSON.parse(localStorage.getItem(REPORT_KEY) || 'null');
  if (v?.cols && v?.secs) repOpts = { cols: { ...repOpts.cols, ...v.cols }, secs: { ...repOpts.secs, ...v.secs } };
} catch { /* ถูกบล็อก */ }
function saveRepOpts() { try { localStorage.setItem(REPORT_KEY, JSON.stringify(repOpts)); } catch { /* ถูกบล็อก */ } }

function renderReportPop() {
  const box = (list, grp) => list.map(c => `<label><input type="checkbox" data-g="${grp}" data-k="${c.k}" ${repOpts[grp][c.k] ? 'checked' : ''}>${c.label ?? c.th}</label>`).join('');
  $('#rep-cols').innerHTML = box(REPORT_COLS(), 'cols');
  $('#rep-secs').innerHTML = box(REPORT_SECS(), 'secs');
  $$('#report-pop input[type=checkbox]').forEach(el => el.addEventListener('change', () => {
    repOpts[el.dataset.g][el.dataset.k] = el.checked;
    saveRepOpts();
  }));
}
function toggleReportPop(show) {
  if (show && !run.report) return;
  if (show) renderReportPop();
  $('#report-pop').hidden = !show;
}

/* ───────── Show mesh ───────── */
function toggleMesh(on = !viewer.display.mesh) {
  viewer.setDisplay({ mesh: on });
  const b = $('#btn-mesh');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}

/* ───────── สี CDU: 'band' = เขียว/เหลือง/แดงทั้งโมดูล (ค่าเริ่มต้น) · 'shade' = ไล่เฉดบนหน้าคอยล์ดูดลม ───────── */
const CDU_COLOR_KEY = 'cfd-cdu-color';
let cduColorPref = 'band';
try { if (localStorage.getItem(CDU_COLOR_KEY) === 'shade') cduColorPref = 'shade'; } catch { /* ถูกบล็อก */ }
function setCduColor(v) {
  v = v === 'shade' ? 'shade' : 'band';
  try { localStorage.setItem(CDU_COLOR_KEY, v); } catch { /* ถูกบล็อก */ }
  $$('#d-cducolor button').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  viewer.setDisplay({ cduColor: v });
  updateBandLegend();
}

/* ───────── แสดงด้านดูดลม ───────── */
function toggleSuction(on = !viewer.display.suction) {
  viewer.setDisplay({ suction: on });
  const b = $('#btn-suction');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}

/** เก็บข้อมูลที่รายงานต้องใช้จากผลปัจจุบัน (ใช้ทั้งรายงานเดี่ยว และเก็บผลแต่ละ case ของ batch) */
function reportSnapshot(shots) {
  const units = unitsNow();
  if (!units) return null;
  const r = run.report;
  return {
    name: scene.name, site: { ...scene.site }, units,
    mesh: { h: run.mesh.h, nx: run.mesh.nx, ny: run.mesh.ny, nz: run.mesh.nz },
    time: r.time, converged: r.converged, balance: r.balance.ratio, avgWindow: r.avgWindow,
    advice: $('#advice').innerHTML,
    shots: shots || (captures.length ? captures.map(c => ({ ...c })) : [{ url: viewer.snapshot(), caption: L('ภาพ 3 มิติ', '3D view') }]),
    date: new Date().toLocaleString(L('th-TH', 'en-GB')),
  };
}

const REPORT_CSS = `body{font-family:"IBM Plex Sans Thai",Tahoma,sans-serif;color:#1c2a36;max-width:1000px;margin:24px auto;padding:0 18px}
    h1{margin:0}table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0}th,td{border:1px solid #c8d3dc;padding:5px 7px;text-align:left}
    td.n{text-align:right;font-family:monospace}th{background:#eef3f7}img{width:100%;border:1px solid #c8d3dc;border-radius:6px}figure{margin:14px 0;page-break-inside:avoid}figcaption{font-size:13px;color:#4a5d6c;margin-top:4px}
    .muted{color:#667a8a}.criteria{list-style:none;padding-left:0}.criteria li{margin:4px 0}
    .chip{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
    .chip-green{background:#3ecf6e}.chip-yellow{background:#f5c518}.chip-red{background:#e5433b}
    .remark{border-top:1px solid #c8d3dc;margin-top:22px;padding-top:8px;font-size:13px}.ok{color:#1c8a55}.watch{color:#b8860b}.bad{color:#c8551b}.trip{color:#c21d2d}ul{padding-left:18px}
    .case{page-break-before:always;border-top:2px solid #1c2a36;margin-top:28px;padding-top:6px}.case-vars{font-weight:600}.worst{font-weight:700;background:#fff4e5}
    @media print{body{margin:0;max-width:none}}`;

function reportDoc(title, body) {
  return `<!DOCTYPE html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${esc(title)} — CDU Airflow CFD</title><style>${REPORT_CSS}</style></head><body>${body}</body></html>`;
}

/** สภาพลมเป็นข้อความ */
function windText(site) {
  if (!(site.windSpeed > 0)) return L('ไม่มีลม', 'no wind');
  const p = WIND_PROFILES[site.windProfile] && site.windProfile !== 'uniform'
    ? L(` · โปรไฟล์ ${WIND_PROFILES[site.windProfile].th} ที่ความสูงอ้างอิง ${site.windRefH} ม. (พื้นที่วางเครื่องสูง ${site.groundElev} ม. จากพื้นดิน)`, ` · ${WIND_PROFILES[site.windProfile].en} profile at ${site.windRefH} m reference height (site ${site.groundElev} m above ground)`) : '';
  return `${L('ลม', 'wind')} ${site.windSpeed} m/s · ${dirName(site.windDir)} (${site.windDir}°)${p}`;
}

/** เนื้อหารายงานของผลหนึ่งชุด — level = ระดับหัวข้อ (1 = รายงานเดี่ยว, 2 = case ในรายงานรวม) */
function reportBody(snap, { level = 1, caseLine = '' } = {}) {
  const H = level === 1 ? 'h1' : 'h2', h = level === 1 ? 'h2' : 'h3';
  const cols = REPORT_COLS().filter(c => repOpts.cols[c.k]);
  const sec = repOpts.secs;
  const tbl = snap.units.map(u => `<tr>${cols.map(c => c.td(u)).join('')}</tr>`).join('');
  let advice = snap.advice;
  if (!repOpts.cols.cap) advice = advice.replace(/<span class="adv-cap">.*?<\/span>/g, '');
  return `<${H}>${esc(snap.name)}</${H}>${level === 1 ? `<p class="muted">${L('รายงานจาก CDU Airflow CFD', 'Report from CDU Airflow CFD')} · ${snap.date}</p>` : ''}
    ${caseLine ? `<p class="case-vars">${esc(caseLine)}</p>` : ''}
    <p>${L('อากาศภายนอก', 'Ambient')} ${snap.site.ambient} °C · ${windText(snap.site)} · ${L('เซลล์', 'cell')} ${snap.mesh.h} ${L('ม.', 'm')}
      (${snap.mesh.nx}×${snap.mesh.ny}×${snap.mesh.nz}) · ${L('เวลาจำลอง', 'simulated time')} ${snap.time.toFixed(0)} s · ${snap.converged ? L('ลู่เข้าแล้ว', 'Converged') : L('ยังไม่ลู่เข้า', 'not converged')}
      · ${L('สมดุลพลังงาน', 'energy balance')} ${(snap.balance * 100).toFixed(1)}%</p>
    ${sec.figs ? snap.shots.map((c, i) => `<figure><img src="${c.url}" alt="${esc(c.caption)}"><figcaption>${L('รูปที่', 'Figure')} ${i + 1} — ${esc(c.caption)}</figcaption></figure>`).join('') : ''}
    ${cols.length ? `<${h}>${L('ผลรายเครื่อง', 'Results per unit')}</${h}>
    <table><tr>${cols.map(c => `<th>${c.th}</th>`).join('')}</tr>${tbl}</table>` : ''}
    ${sec.advice ? `<${h}>${L('ข้อสังเกต', 'Observations')}</${h}><ul>${advice}</ul>` : ''}
    <p class="muted">${L(`ค่าเฉลี่ยตามเวลาในช่วง ${snap.avgWindow.toFixed(0)} วินาทีสุดท้าย · ตัวเลขสมรรถนะเป็นค่าอ้างอิงโดยประมาณ ใช้เพื่อเปรียบเทียบผังการวางเครื่อง`, `Time-averaged over the last ${snap.avgWindow.toFixed(0)} s · performance figures are approximate references for comparing layouts`)}</p>`;
}

/** ท้ายรายงาน: เกณฑ์อุณหภูมิลมกลับ + หมายเหตุ */
function reportTail() {
  const sec = repOpts.secs;
  return `${sec.criteria ? `<h2>${L('เกณฑ์อุณหภูมิลมกลับ', 'Return-air temperature criteria')}</h2>${bandCriteriaHTML()}` : ''}
    ${sec.remark ? `<div class="remark">${remarkHTML()}</div>` : ''}`;
}

function exportReport() {
  const snap = reportSnapshot();
  if (!snap) return;
  download(`${safeName(scene.name)}-report.html`, reportDoc(scene.name, reportBody(snap) + reportTail()), 'text/html');
}

/* ───────── Batch: รันหลายทางเลือกต่อกันอัตโนมัติ ─────────
 * ตัวแปร (batch.js) → ผลคูณของค่าทุกตัวเป็น case → คำนวณทีละ case จนลู่เข้า (หรือถึงเพดานเวลา)
 * → เก็บผล + ภาพ 2 มุม → case ถัดไป → จบแล้วคืนแบบตั้งต้น ผลทุก case ขึ้นตาราง Batch และตารางเปรียบเทียบ
 * ผลเก็บไว้ในหน่วยความจำของรอบนี้ (ปิดหน้าแล้วหาย) — ดาวน์โหลดรายงานไว้ก่อนปิด */
const batch = {
  vars: [], wind: false, calm: true, windSpeed: 2, model: new Map(),
  active: false, cases: [], i: -1, results: [], baseJSON: null, startWall: 0,
};

function toggleBatchPop(show) {
  if (show) {
    if (batch.active) { toast(L('กำลังรัน Batch อยู่', 'A batch is already running')); return; }
    if (!batch.vars.length && !batch.wind) batch.wind = true;
    if (!(batch.windSpeed > 0)) batch.windSpeed = scene.site.windSpeed > 0 ? scene.site.windSpeed : 2;
    renderBatchPop();
  }
  $('#batch-pop').hidden = !show;
}

/** ตัวแปรที่ใช้จริง (รวมทิศลม 4 ทิศถ้าเลือก) */
function batchVars() {
  return [...batch.vars.map(v => ({ ...v, values: parseValues(v.text) })), ...(batch.wind ? [{ kind: 'wind', target: 'all', values: [...WIND4, ...(batch.calm ? [CALM] : [])] }] : [])];
}

function renderBatchPop() {
  const info = KIND_INFO();
  const objOpts = (v) => {
    const t = info[v.kind].objType;
    const objs = scene.objects.filter(o => o.type === t && (v.kind !== 'louver' || true));
    return `<option value="all" ${v.target === 'all' ? 'selected' : ''}>${info[v.kind].allLabel}</option>` + objs.map(o => `<option value="${o.id}" ${String(v.target) === String(o.id) ? 'selected' : ''}>${esc(o.name)}${o.type === 'wall' ? ` (${o.louver > 0 ? `louver ${o.louver}%` : L('ทึบ', 'solid')} · ${fmt(o.height)} ${L('ม.', 'm')})` : ` (${esc(o.model)})`}</option>`).join('');
  };
  $('#bt-vars').innerHTML = batch.vars.length ? batch.vars.map((v, i) => `<div class="bt-var" data-i="${i}">
      <b>${info[v.kind].label}</b>
      <select data-f="target" title="${L('วัตถุที่จะปรับ', 'Object to change')}">${objOpts(v)}</select>
      <label>${L('ค่า', 'Values')} (${info[v.kind].unit}) <input type="text" data-f="text" value="${esc(v.text)}" placeholder="${info[v.kind].def}" title="${L('คั่นด้วยจุลภาค เช่น', 'Comma-separated, e.g.')} ${info[v.kind].def}"></label>
      <button class="ghost danger" data-f="del" title="${L('ลบตัวแปรนี้', 'Remove this variable')}">✕</button></div>`).join('')
    : `<p class="muted small">${L('ยังไม่มีตัวแปร — เพิ่มด้านล่าง หรือรันเฉพาะลม 4 ทิศ', 'No variables yet — add one below, or run the 4 wind directions only')}</p>`;
  $('#bt-add').innerHTML = BATCH_KINDS.filter(k => k !== 'wind').map(k => `<button class="ghost mini" data-k="${k}">+ ${info[k].label}</button>`).join('');
  $('#bt-wind').checked = batch.wind;
  $('#bt-calm').checked = batch.calm;
  $('#bt-calm').disabled = !batch.wind;
  $('#bt-wspeed').value = batch.windSpeed;
  $('#bt-wspeed').disabled = !batch.wind;
  $$('#bt-vars .bt-var').forEach(row => {
    const v = batch.vars[Number(row.dataset.i)];
    $('[data-f="target"]', row).addEventListener('change', (e) => { v.target = e.target.value; renderBatchPreview(); });
    $('[data-f="text"]', row).addEventListener('input', (e) => { v.text = e.target.value; renderBatchPreview(); });
    $('[data-f="del"]', row).addEventListener('click', () => { batch.vars.splice(Number(row.dataset.i), 1); renderBatchPop(); });
  });
  $$('#bt-add button').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.k;
    batch.vars.push({ kind: k, target: 'all', text: info[k].def });
    renderBatchPop();
  }));
  renderBatchPreview();
}

function renderBatchPreview() {
  const vars = batchVars();
  const err = validateVars(scene, vars, batch.windSpeed);
  const box = $('#bt-preview'), go = $('#bt-go');
  if (err) { box.innerHTML = `<p class="warn-text">${esc(err)}</p>`; go.disabled = true; return; }
  const cases = buildCases(scene, vars, batch.windSpeed);
  const d = domainOf(scene);
  const over = cases.length > MAX_CASES;
  go.disabled = over;
  box.innerHTML = `<p><b>${cases.length} case</b> · ${L(`เมชละ ≈ ${fmtK(d.cells)} เซลล์`, `≈ ${fmtK(d.cells)} cells each`)}${over ? ` — <span class="warn-text">${L(`เกิน ${MAX_CASES} case ลดจำนวนค่า`, `more than ${MAX_CASES} cases — use fewer values`)}</span>` : ''}</p>
    <ol class="bt-list">${cases.slice(0, 60).map(c => `<li>${esc(c.label)}</li>`).join('')}</ol>`;
}

function bindBatch() {
  for (const id of ['#btn-batch', '#btn-batch2']) $(id)?.addEventListener('click', () => toggleBatchPop(true));
  $('#btn-wind4')?.addEventListener('click', () => { batch.vars = []; batch.wind = true; toggleBatchPop(true); });
  $('#batch-pop .keys-x').addEventListener('click', () => toggleBatchPop(false));
  $('#batch-pop').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) toggleBatchPop(false); });
  $('#bt-wind').addEventListener('change', (e) => { batch.wind = e.target.checked; renderBatchPop(); });
  $('#bt-calm').addEventListener('change', (e) => { batch.calm = e.target.checked; renderBatchPreview(); });
  $('#bt-wspeed').addEventListener('input', (e) => { batch.windSpeed = parseFloat(e.target.value) || 0; renderBatchPreview(); });
  $('#bt-go').addEventListener('click', startBatch);
  $('#bt-cancel').addEventListener('click', cancelBatch);
  $('#bt-rep-all').addEventListener('click', exportBatchReport);
  $('#bt-rep-each').addEventListener('click', exportBatchCaseReports);
  $('#bt-csv').addEventListener('click', exportBatchCSV);
  $('#bt-clear').addEventListener('click', () => { if (!batch.active && confirm(L('ล้างผล Batch ทั้งหมด?', 'Clear all batch results?'))) { batch.results = []; batch.cases = []; renderBatchResults(); } });
}

function startBatch() {
  const vars = batchVars();
  const err = validateVars(scene, vars, batch.windSpeed);
  if (err) { toast(err); return; }
  const cases = buildCases(scene, vars, batch.windSpeed);
  if (cases.length > MAX_CASES) return;
  if (!hasOpenFace()) { toast(L('ต้องมีขอบโดเมนแบบ "เปิด" อย่างน้อยหนึ่งด้าน', 'At least one domain boundary must be "Open"'), 5000); return; }
  const d = domainOf(scene);
  if (meshTooBig(d)) { toast(meshTooBig(d), 6000); return; }
  if (d.cells > BIG_MESH && !confirm(L(`เมช ${fmtK(d.cells)} เซลล์ × ${cases.length} case อาจใช้เวลานานมาก คำนวณต่อหรือไม่?`, `${fmtK(d.cells)} cells × ${cases.length} cases may take very long. Continue?`))) return;
  toggleBatchPop(false);
  if (run.state === 'running') runner.send({ cmd: 'pause' });
  Object.assign(batch, { active: true, cases, i: -1, results: [], model: new Map(), baseJSON: JSON.stringify(scene), startWall: performance.now() });
  showTab('results');
  batchNext();
}

function loadSceneQuiet(json) {
  scene = normalizeScene(JSON.parse(json));
  selectedId = null;
  afterChange(false);
}

async function batchNext() {
  if (!batch.active) return;
  batch.i++;
  if (batch.i >= batch.cases.length) { finishBatch(); return; }
  const c = batch.cases[batch.i];
  loadSceneQuiet(c.sceneJSON);
  resetResults();
  // ภาพแบบจำลอง (Plan / front / isometric / top) ของทางเลือกนี้ — ถ่ายครั้งเดียวต่อกลุ่ม (ต่างกันแค่ทิศลม = แบบเดียวกัน)
  if (!batch.model.has(c.group)) {
    renderBatchResults();
    try { batch.model.set(c.group, await captureModelShots()); } catch { batch.model.set(c.group, null); }
    if (!batch.active) return;
  }
  const why = startNewRun(true);
  renderBatchResults();
  if (why) batchCaseFailed(why);
}

async function batchCaseDone() {
  if (!batch.active) return;
  const c = batch.cases[batch.i];
  try {
    const named = await captureResultShots();
    const cap = k => `Case ${c.no}: ${c.label} — ${REPORT_SHOT_NAME()[k]}`;
    const snap = reportSnapshot(['iso', 'top', 'side'].filter(k => named[k]).map(k => ({ url: named[k].url, caption: cap(k) })));
    batch.results.push({ ...c, snap, named, ok: !!snap });
  } catch (e) { batch.results.push({ ...c, ok: false, error: e.message || String(e) }); }
  batchNext();
}

function batchCaseFailed(why) {
  if (!batch.active) return;
  batch.results.push({ ...batch.cases[batch.i], ok: false, error: why });
  setTimeout(batchNext, 0);
}

function finishBatch(cancelled = false) {
  batch.active = false;
  if (batch.baseJSON) loadSceneQuiet(batch.baseJSON);
  batch.baseJSON = null;
  resetResults();
  renderBatchResults();
  showTab('results');
  const n = batch.results.filter(r => r.ok).length;
  toast(cancelled ? L(`ยกเลิก Batch — เก็บผลไว้ ${n} case`, `Batch cancelled — ${n} case(s) kept`)
    : L(`Batch เสร็จ ${n}/${batch.cases.length} case ใน ${fmtDur((performance.now() - batch.startWall) / 1000)} — คืนแบบตั้งต้นแล้ว`, `Batch finished: ${n}/${batch.cases.length} cases in ${fmtDur((performance.now() - batch.startWall) / 1000)} — the original model is restored`), 6000);
}

function cancelBatch() {
  if (!batch.active) return;
  if (!confirm(L('ยกเลิก Batch? case ที่คำนวณเสร็จแล้วยังเก็บไว้', 'Cancel the batch? Finished cases are kept'))) return;
  runner.send({ cmd: 'pause' });
  finishBatch(true);
}

/** ค่าสรุปของ case */
function caseSummary(r) {
  const u = r.snap.units;
  const worst = u.reduce((a, b) => (b.dT > a.dT ? b : a));
  const avg = u.reduce((s, x) => s + x.dT * x.cmm, 0) / u.reduce((s, x) => s + x.cmm, 0);
  return { worst, avg, tinMax: Math.max(...u.map(x => x.TinMax)) };
}

/** ตารางลม 4 ทิศ: แยกตามกลุ่ม (ค่าตัวแปรอื่นที่เหมือนกัน) แถว = CDU, คอลัมน์ = ทิศลม, ช่องท้าย = ทิศที่แย่ที่สุด */
function windTables(results, forReport = false) {
  const groups = new Map();
  for (const r of results) if (r.ok && r.parts.some(p => p.kind === 'wind')) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  const out = [];
  for (const [g, rs] of groups) {
    rs.sort((a, b) => (a.windDir === CALM) - (b.windDir === CALM) || a.windDir - b.windDir);
    const names = rs[0].snap.units.map(u => u.name);
    const rows = names.map((n, k) => {
      const tins = rs.map(r => r.snap.units[k]?.Tin ?? NaN);
      const wi = tins.reduce((m, t, i) => (t > tins[m] ? i : m), 0);
      const cell = (t, i) => `<td class="n${i === wi ? ' worst' : ''}">${forReport ? `<i class="chip chip-${band(t)}"></i>` : chip(t)}${t.toFixed(2)}</td>`;
      return `<tr><td>${esc(n)}</td>${tins.map(cell).join('')}<td class="n"><b>${tins[wi].toFixed(2)}</b> · ${dirName(rs[wi].windDir, true)}</td></tr>`;
    });
    const colHead = r => (r.windDir === CALM ? dirName(CALM, true) : `${dirName(r.windDir, true)} ${r.snap.site.windSpeed} m/s`);
    out.push(`<div class="wind4">${g ? `<p class="case-vars">${esc(g)}</p>` : ''}
      <table class="cmp-table"><thead><tr><th>CDU</th>${rs.map(r => `<th class="n">${colHead(r)}</th>`).join('')}<th class="n">${L('แย่ที่สุด', 'Worst')}</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`);
  }
  return out.join('');
}

function renderBatchResults() {
  const card = $('#batch-card');
  if (!card) return;
  const has = batch.results.length || batch.active;
  card.hidden = !has;
  if (!has) return;
  $('#bt-status').textContent = batch.active
    ? L(`กำลังรัน Case ${batch.i + 1} / ${batch.cases.length} — ${batch.cases[batch.i]?.label || ''}`, `Running case ${batch.i + 1} / ${batch.cases.length} — ${batch.cases[batch.i]?.label || ''}`)
    : L(`${batch.results.filter(r => r.ok).length} case เสร็จ`, `${batch.results.filter(r => r.ok).length} case(s) done`);
  $('#bt-cancel').hidden = !batch.active;
  for (const id of ['#bt-rep-all', '#bt-rep-each', '#bt-csv', '#bt-clear', '#bt-form']) $(id).disabled = batch.active || !batch.results.some(r => r.ok);
  const rows = batch.results.map((r, i) => {
    if (!r.ok) return `<tr><td>${r.no}</td><td>${esc(r.label)}</td><td colspan="4" class="warn-text">${L('คำนวณไม่ได้', 'Failed')}: ${esc(r.error || '')}</td><td></td></tr>`;
    const s = caseSummary(r);
    return `<tr><td>${r.no}</td><td>${esc(r.label)}${r.snap.converged ? '' : ` <span class="muted small">(${L('ยังไม่นิ่ง', 'not settled')})</span>`}</td>
      <td class="n st-${s.worst.status.key}">+${s.worst.dT.toFixed(2)}</td><td>${esc(s.worst.name)}</td><td class="n">+${s.avg.toFixed(2)}</td><td class="n">${s.tinMax.toFixed(1)}</td>
      <td class="bt-act"><button class="ghost mini" data-rep="${i}">${L('รายงาน', 'Report')}</button><button class="ghost mini" data-open="${i}">${L('เปิด', 'Open')}</button></td></tr>`;
  });
  if (batch.active) for (let k = batch.results.length; k < batch.cases.length; k++) {
    const c = batch.cases[k];
    rows.push(`<tr class="muted"><td>${c.no}</td><td>${esc(c.label)}</td><td colspan="5">${k === batch.i ? L('กำลังคำนวณ…', 'running…') : L('รอคิว', 'queued')}</td></tr>`);
  }
  $('#bt-table tbody').innerHTML = rows.join('');
  $('#bt-wind4').innerHTML = windTables(batch.results);
  $$('#bt-table [data-rep]').forEach(b => b.addEventListener('click', () => exportCaseReport(batch.results[Number(b.dataset.rep)])));
  $$('#bt-table [data-open]').forEach(b => b.addEventListener('click', () => {
    if (batch.active) return;
    const r = batch.results[Number(b.dataset.open)];
    edit(() => { scene = normalizeScene(JSON.parse(r.sceneJSON)); }, true, true);
    resetResults();
    showTab('tool');
    toast(L(`เปิดแบบของ Case ${r.no} — กดคำนวณเพื่อดูสนามลมในภาพ 3D`, `Opened case ${r.no} — press Run to see its flow field in 3D`));
  }));
}

function caseReportHTML(r) {
  return reportDoc(r.snap.name, reportBody(r.snap) + reportTail());
}

function exportCaseReport(r) {
  if (!r?.ok) return;
  download(`${safeName(r.snap.name.split(' — ')[0])}-case${String(r.no).padStart(2, '0')}-report.html`, caseReportHTML(r), 'text/html');
}

/** ดาวน์โหลดรายงานแยกทุก case (ไฟล์ละ case — เบราว์เซอร์อาจถามอนุญาตดาวน์โหลดหลายไฟล์) */
function exportBatchCaseReports() {
  const ok = batch.results.filter(r => r.ok);
  ok.forEach((r, k) => setTimeout(() => exportCaseReport(r), k * 400));
}

/** รายงานรวม: ตารางสรุปทุก case + ตารางลม 4 ทิศ + รายละเอียดแต่ละ case */
function exportBatchReport() {
  const ok = batch.results.filter(r => r.ok);
  if (!ok.length) return;
  const base = ok[0].snap.name.split(' — ')[0];
  const sum = ok.map(r => {
    const s = caseSummary(r);
    return `<tr><td>${r.no}</td><td>${esc(r.label)}</td><td class="n ${s.worst.status.key}">+${s.worst.dT.toFixed(2)}</td><td>${esc(s.worst.name)}</td><td class="n">+${s.avg.toFixed(2)}</td><td class="n">${s.tinMax.toFixed(1)}</td><td>${r.snap.converged ? L('ลู่เข้า', 'yes') : L('ยังไม่ลู่เข้า', 'no')}</td></tr>`;
  }).join('');
  const w4 = windTables(ok, true);
  const body = `<h1>${esc(base)} — ${L('ผลการเปรียบเทียบหลายทางเลือก (Batch)', 'Comparison of options (batch)')}</h1>
    <p class="muted">${L('รายงานจาก CDU Airflow CFD', 'Report from CDU Airflow CFD')} · ${new Date().toLocaleString(L('th-TH', 'en-GB'))} · ${ok.length} case</p>
    <h2>${L('สรุปทุก Case', 'Summary of all cases')}</h2>
    <table><tr><th>Case</th><th>${L('ตัวแปร', 'Variables')}</th><th>${L('ΔT สูงสุด °C', 'Max ΔT °C')}</th><th>${L('เครื่องที่แย่สุด', 'Worst unit')}</th><th>${L('ΔT เฉลี่ย °C', 'Mean ΔT °C')}</th><th>${L('T ลมเข้าสูงสุด °C', 'Max inlet T °C')}</th><th>${L('ลู่เข้า', 'Converged')}</th></tr>${sum}</table>
    ${w4 ? `<h2>${L('T ลมเข้าเฉลี่ยรายเครื่อง ลม 4 ทิศ (°C)', 'Mean inlet T per unit, 4 wind directions (°C)')}</h2>
      <p class="muted">${L('ช่องเน้น = ทิศลมที่ทำให้เครื่องนั้นมี T ลมเข้าสูงที่สุด', 'Highlighted = the wind direction giving that unit its highest inlet T')}</p>${w4}` : ''}
    ${ok.map(r => `<section class="case">${reportBody(r.snap, { level: 2 })}</section>`).join('')}
    ${reportTail()}`;
  download(`${safeName(base)}-batch-report.html`, reportDoc(base, body), 'text/html');
}

function exportBatchCSV() {
  const ok = batch.results.filter(r => r.ok);
  if (!ok.length) return;
  const head = L(['Case', 'ตัวแปร', 'ทิศลม', 'CDU', 'รุ่น', 'T ลมเข้าเฉลี่ย C', 'T ลมเข้าสูงสุด C', 'dT C', 'ลมวนกลับ %', 'T ลมเป่า C', 'สถานะ', 'ลู่เข้า'],
    ['Case', 'Variables', 'Wind', 'CDU', 'Model', 'Mean inlet T C', 'Max inlet T C', 'dT C', 'Recirculation %', 'Discharge T C', 'Status', 'Converged']);
  const rows = ok.flatMap(r => r.snap.units.map(u => [r.no, r.label, r.snap.site.windSpeed > 0 ? `${dirName(r.snap.site.windDir, true)} ${r.snap.site.windSpeed} m/s` : '-', u.name, u.model,
    u.Tin.toFixed(2), u.TinMax.toFixed(2), u.dT.toFixed(2), (u.Cin * 100).toFixed(1), u.Tdis.toFixed(1), u.status.label, r.snap.converged ? 'Y' : 'N']));
  const csv = '﻿' + [head, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`${safeName(ok[0].snap.name.split(' — ')[0])}-batch.csv`, csv, 'text/csv');
}

/* ───────── แบบ DXF ฉากหลัง (underlay) ─────────
 * เส้นของแบบวาดบนพื้น ใช้ดูดจุดปลายเส้นขณะวาดผนัง/วางวัตถุ และแปลงเลเยอร์ที่เลือกเป็นผนัง / louver / อาคาร / CDU
 * เก็บแยกจากฉาก (ไม่อยู่ใน undo และไม่มีผลกับการคำนวณ) — จำไว้กับเบราว์เซอร์ และบันทึกลงไฟล์โปรเจกต์ .json
 * พิกัด: แกน X ของแบบ → ทิศตะวันออก (+x), แกน Y ของแบบ → ทิศเหนือ (−z) แล้วหมุน/เลื่อนตามค่าตำแหน่ง */
const UNDERLAY_KEY = 'cdu-airflow-cfd:underlay';
const DXF_UNITS = [['auto', 0], ['mm', 0.001], ['cm', 0.01], ['m', 1], ['in', 0.0254], ['ft', 0.3048]];
const DXF_MODES = () => [['none', L('ไม่แปลง', 'Keep as lines')], ['wall', L('ผนังทึบ', 'Solid wall')], ['louver', 'Louver'], ['building', L('อาคาร (สี่เหลี่ยมปิด)', 'Building (closed rectangle)')], ['cdu', L('CDU (สี่เหลี่ยมปิด)', 'CDU (closed rectangle)')]];
let underlay = null;
let ulWorld = null;   // แคชพิกัดโลกของเส้นทุกเลเยอร์

function loadUnderlay() {
  try { const v = JSON.parse(localStorage.getItem(UNDERLAY_KEY) || 'null'); return v?.layers ? v : null; } catch { return null; }
}
function saveUnderlay() {
  try {
    if (underlay) localStorage.setItem(UNDERLAY_KEY, JSON.stringify(underlay)); else localStorage.removeItem(UNDERLAY_KEY);
  } catch { toast(L('แบบ DXF ใหญ่เกินกว่าจะจำไว้ในเบราว์เซอร์ — บันทึกไฟล์โปรเจกต์ .json เพื่อเก็บไว้', 'The DXF is too large to keep in the browser — save the project .json file to keep it'), 5000); }
}

/** แปลงพิกัดแบบ (หน่วยไฟล์) → พิกัดโลก (ม.) */
function ulXform(u = underlay) {
  const s = u.scale, r = (u.rot || 0) * Math.PI / 180, c = Math.cos(r), n = Math.sin(r);
  return (X, Y) => { const a = X * s, b = Y * s; return [a * c - b * n + u.dx, -(a * n + b * c) + u.dz]; };
}

function setUnderlay(u, persist = true) {
  underlay = u;
  if (u) {
    u.opacity ??= 0.85; u.show ??= true; u.snap ??= true; u.rot ??= 0;
    u.conv = { wallH: 2.4, thick: 0.15, louver: 50, bldgH: 6, ...(u.conv || {}) };
  }
  applyUnderlay();
  if (persist) saveUnderlay();
}

function applyUnderlay() {
  const u = underlay;
  if (!u) { ulWorld = null; viewer.setUnderlay(null); updateDxfButton(); return; }
  const f = ulXform(u);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const pts = new Map();
  ulWorld = u.layers.map(l => {
    const segs = [];
    const polys = l.polys.map(p => {
      const w = [];
      for (let k = 0; k < p.pts.length; k += 2) w.push(f(p.pts[k], p.pts[k + 1]));
      for (const [x, z] of w) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      const n = w.length, last = p.closed ? n : n - 1;
      for (let k = 0; k < last; k++) { const a = w[k], b = w[(k + 1) % n]; segs.push(a[0], a[1], b[0], b[1]); }
      if (l.visible) for (const [x, z] of w) pts.set(`${x.toFixed(3)},${z.toFixed(3)}`, [x, z]);
      return { pts: w, closed: p.closed };
    });
    return { name: l.name, color: l.color, visible: l.visible, segs: new Float32Array(segs), polys };
  });
  const snapPts = new Float32Array([...pts.values()].flat());
  viewer.setUnderlay(u.show ? ulWorld : [], u.show ? snapPts : null, isFinite(x0) ? { x0, z0, x1, z1 } : null, u.opacity);
  viewer.setUnderlaySnap(u.show && u.snap);
  updateDxfButton();
}

function updateDxfButton() {
  const b = $('#btn-dxf-view');
  if (!b) return;
  b.hidden = !underlay;
  b.classList.toggle('on', !!underlay?.show);
}

function toggleDxfPop(show) {
  if (show) renderDxfPop();
  $('#dxf-pop').hidden = !show;
}

function importDxfFile(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = parseDXF(String(rd.result));
      if (!d.polys.length) { toast(L('ไม่พบเส้นในไฟล์ DXF (รองรับ LINE / POLYLINE / ARC / CIRCLE / บล็อก)', 'No lines found in the DXF (LINE / POLYLINE / ARC / CIRCLE / blocks are supported)'), 6000); return; }
      const scale = d.units || guessUnits(d.bbox);
      const byLayer = new Map();
      for (const p of d.polys) {
        if (!byLayer.has(p.layer)) byLayer.set(p.layer, []);
        byLayer.get(p.layer).push({ pts: p.pts.flat().map(v => Math.round(v * 1000) / 1000), closed: p.closed });
      }
      const layers = [...byLayer].map(([name, polys]) => ({ name, color: d.layers.get(name)?.color || '#37474f', visible: !d.layers.get(name)?.off, polys, mode: 'none' }));
      layers.sort((a, b) => a.name.localeCompare(b.name));
      const u = { name: file.name, unitAuto: !d.units, scale, rot: 0, dx: 0, dz: 0, layers, bbox: d.bbox };
      // วางมุมซ้ายบนของแบบ (X น้อยสุด, Y มากสุด) ไว้ที่จุด (0, 0) — ปรับได้ภายหลัง
      fitUnderlayOrigin(u);
      setUnderlay(u);
      renderDxfPop();
      viewer.setView(viewer.view);
      const nSeg = layers.reduce((s, l) => s + l.polys.length, 0);
      toast(L(`นำเข้า ${file.name}: ${layers.length} เลเยอร์ ${nSeg} เส้น · หน่วย ${unitName(scale)}${d.units ? '' : ' (เดา — ตรวจสอบ)'}${d.skipped ? ` · ข้าม ${d.skipped} รายการที่ไม่รองรับ` : ''}`,
        `Imported ${file.name}: ${layers.length} layers, ${nSeg} lines · units ${unitName(scale)}${d.units ? '' : ' (guessed — please check)'}${d.skipped ? ` · ${d.skipped} unsupported entities skipped` : ''}`), 6000);
    } catch (e) {
      toast(/Binary/.test(e.message) ? L('ไฟล์ DXF แบบ binary ยังไม่รองรับ — บันทึกจาก CAD เป็น DXF แบบ ASCII', 'Binary DXF is not supported — save it from CAD as ASCII DXF') : L('อ่านไฟล์ DXF ไม่ได้: ', 'Cannot read the DXF: ') + e.message, 6000);
    }
  };
  rd.readAsText(file);
}

const unitName = s => (DXF_UNITS.find(u => u[1] === s)?.[0] || `${s} m`);

function fitUnderlayOrigin(u) {
  u.dx = 0; u.dz = 0;
  const f = ulXform(u), b = u.bbox;
  const cs = [f(b.x0, b.y0), f(b.x1, b.y0), f(b.x0, b.y1), f(b.x1, b.y1)];
  u.dx = -Math.min(...cs.map(c => c[0]));
  u.dz = -Math.min(...cs.map(c => c[1]));
  u.dx = round3(u.dx); u.dz = round3(u.dz);
}

function renderDxfPop() {
  const u = underlay;
  $('#dxf-body').hidden = !u;
  $('#dxf-name').textContent = u ? u.name : L('ยังไม่มีแบบ', 'No drawing yet');
  if (!u) return;
  $('#dxf-unit').value = DXF_UNITS.find(x => x[1] === u.scale)?.[0] || 'mm';
  $('#dxf-dx').value = fmt(u.dx); $('#dxf-dz').value = fmt(u.dz); $('#dxf-rot').value = fmt(u.rot);
  $('#dxf-show').checked = u.show; $('#dxf-snap').checked = u.snap;
  $('#dxf-op').value = u.opacity;
  for (const k of ['wallH', 'thick', 'louver', 'bldgH']) $(`#dxf-${k}`).value = u.conv[k];
  const modes = DXF_MODES();
  $('#dxf-layers tbody').innerHTML = u.layers.map((l, i) => `<tr data-i="${i}">
    <td><input type="checkbox" data-f="vis" ${l.visible ? 'checked' : ''} title="${L('แสดง / ซ่อน', 'Show / hide')}"></td>
    <td><i class="swatch" style="background:${esc(l.color)}"></i>${esc(l.name)}</td><td class="n">${l.polys.length}</td>
    <td><select data-f="mode">${modes.map(([v, t]) => `<option value="${v}" ${l.mode === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>`).join('');
  $$('#dxf-layers tbody tr').forEach(tr => {
    const l = u.layers[Number(tr.dataset.i)];
    $('[data-f="vis"]', tr).addEventListener('change', (e) => { l.visible = e.target.checked; applyUnderlay(); saveUnderlay(); });
    $('[data-f="mode"]', tr).addEventListener('change', (e) => { l.mode = e.target.value; saveUnderlay(); renderDxfCount(); });
  });
  renderDxfCount();
}

/** วัตถุที่จะได้จากการแปลง (ยังไม่สร้าง) */
function dxfObjects() {
  const u = underlay, c = u.conv, out = [];
  let skipped = 0;
  const r3 = round3;
  u.layers.forEach((l, i) => {
    if (l.mode === 'none') return;
    for (const p of ulWorld[i].polys) {
      if (l.mode === 'building' || l.mode === 'cdu') {
        const rc = p.closed ? rectOf(p.pts) : null;
        if (!rc) { skipped++; continue; }
        if (l.mode === 'building') {
          // ขอบแรกของสี่เหลี่ยมทิศ (ex, ez) = แกน x ของอาคารหลังหมุน: rotation.y = θ → (cos θ, −sin θ)
          let rot = -rc.ang * 180 / Math.PI;
          rot = Math.round((((rot % 360) + 360) % 360) * 10) / 10;
          out.push({ type: 'building', props: { name: undefined, x: r3(rc.cx), z: r3(rc.cy), w: r3(rc.w), d: r3(rc.d), h: c.bldgH, rot } });
        } else {
          // CDU: ด้านยาวตามแนวแกนใด → rot 0 / 90 (หน้าเครื่องหัน +z หรือ +x — หมุนเพิ่มได้ภายหลัง)
          const along = Math.abs(Math.cos(rc.ang)) > 0.7 ? (rc.w >= rc.d ? 'x' : 'z') : (rc.w >= rc.d ? 'z' : 'x');
          out.push({ type: 'cdu', props: { x: r3(rc.cx), z: r3(rc.cy), rot: along === 'x' ? 0 : 90, model: lastUsed.model, elev: round2(supportAt(rc.cx, rc.cy) + 0.2) } });
        }
        continue;
      }
      const pts = simplifyCollinear(p.pts, p.closed);
      const n = pts.length, last = p.closed ? n : n - 1;
      for (let k = 0; k < last; k++) {
        const a = pts[k], b = pts[(k + 1) % n];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.1) { skipped++; continue; }
        out.push({ type: 'wall', props: { x1: r3(a[0]), z1: r3(a[1]), x2: r3(b[0]), z2: r3(b[1]), height: c.wallH, thick: c.thick, louver: l.mode === 'louver' ? c.louver : 0 } });
      }
    }
  });
  return { out, skipped };
}

function renderDxfCount() {
  if (!underlay) return;
  const { out, skipped } = dxfObjects();
  const cnt = t => out.filter(o => o.type === t).length;
  $('#dxf-count').textContent = out.length
    ? L(`จะได้ ผนัง/louver ${cnt('wall')} · อาคาร ${cnt('building')} · CDU ${cnt('cdu')}${skipped ? ` (ข้าม ${skipped} — เส้นสั้นกว่า 0.1 ม. หรือไม่ใช่สี่เหลี่ยมปิด)` : ''}`,
      `Will create walls/louvers ${cnt('wall')} · buildings ${cnt('building')} · CDUs ${cnt('cdu')}${skipped ? ` (${skipped} skipped — shorter than 0.1 m or not a closed rectangle)` : ''}`)
    : L('เลือก "แปลงเป็น" ของเลเยอร์ที่ต้องการก่อน', 'Choose "Convert to" for the layers you want first');
  $('#dxf-convert').disabled = !out.length;
}

function convertDxf() {
  const { out } = dxfObjects();
  if (!out.length) return;
  if (out.length > 400 && !confirm(L(`จะสร้างวัตถุ ${out.length} ชิ้น — มากเกินไปอาจทำให้เมชและการแสดงผลช้า ทำต่อหรือไม่?`, `This creates ${out.length} objects — too many may slow the mesh and display. Continue?`))) return;
  if (blockIfLocked()) return;
  edit(() => {
    for (const o of out) {
      const { name, ...props } = o.props;
      void name;
      scene.objects.push(makeObject(scene, o.type, props));
    }
  });
  for (const l of underlay.layers) l.mode = 'none';
  saveUnderlay();
  renderDxfPop();
  viewer.setView(viewer.view);
  toast(L(`สร้างวัตถุจากแบบ DXF ${out.length} ชิ้น — Ctrl+Z เพื่อย้อน`, `Created ${out.length} objects from the DXF — Ctrl+Z to undo`), 5000);
}

function bindDxf() {
  $('#btn-dxf').addEventListener('click', () => toggleDxfPop(true));
  $('#btn-dxf-view').addEventListener('click', () => toggleDxfPop(true));
  $('#dxf-pop .keys-x').addEventListener('click', () => toggleDxfPop(false));
  $('#dxf-pop').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) toggleDxfPop(false); });
  $('#dxf-pick').addEventListener('click', () => $('#dxf-file').click());
  $('#dxf-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importDxfFile(f); e.target.value = ''; });
  const upd = (fn) => () => { if (!underlay) return; fn(); applyUnderlay(); saveUnderlay(); renderDxfPop(); };
  $('#dxf-unit').addEventListener('change', upd(() => { const s = DXF_UNITS.find(x => x[0] === $('#dxf-unit').value)?.[1]; underlay.scale = s || guessUnits(underlay.bbox); fitUnderlayOrigin(underlay); }));
  for (const [id, k] of [['#dxf-dx', 'dx'], ['#dxf-dz', 'dz'], ['#dxf-rot', 'rot']]) {
    $(id).addEventListener('change', upd(() => { const v = parseFloat($(id).value); if (isFinite(v)) underlay[k] = v; }));
  }
  $('#dxf-fit').addEventListener('click', upd(() => fitUnderlayOrigin(underlay)));
  $('#dxf-show').addEventListener('change', upd(() => { underlay.show = $('#dxf-show').checked; }));
  $('#dxf-snap').addEventListener('change', upd(() => { underlay.snap = $('#dxf-snap').checked; }));
  $('#dxf-op').addEventListener('input', () => { if (!underlay) return; underlay.opacity = parseFloat($('#dxf-op').value); applyUnderlay(); });
  $('#dxf-op').addEventListener('change', () => saveUnderlay());
  for (const k of ['wallH', 'thick', 'louver', 'bldgH']) {
    $(`#dxf-${k}`).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (underlay && isFinite(v) && v >= 0) { underlay.conv[k] = k === 'louver' ? Math.min(100, v) : v; saveUnderlay(); renderDxfCount(); }
    });
  }
  $('#dxf-convert').addEventListener('click', convertDxf);
  $('#dxf-remove').addEventListener('click', () => { if (confirm(L('ลบแบบ DXF ฉากหลัง? (วัตถุที่แปลงไปแล้วยังอยู่)', 'Remove the DXF underlay? (Objects already converted stay)'))) { setUnderlay(null); renderDxfPop(); } });
}

/* ───────── ภาพสำหรับรายงานตามแบบฟอร์ม ─────────
 * ผลต่อสภาพลม: top (หน้าตัดแนวนอนที่ระดับกลางคอยล์ของเครื่องที่แย่สุด) · side (หน้าตัดแนวตั้งผ่านเครื่องนั้น มองจาก +Z)
 * · iso (3D + หน้าตัดแนวนอน) · suction (ไล่เฉดอุณหภูมิบนหน้าคอยล์ดูดลม) · pressure (หน้าตัดแนวตั้ง ตัวแปรความดัน)
 * แบบจำลอง (ไม่มีผล): plan (Top พร้อมแบบ DXF ถ้ามี) · front (มองจาก +Z) · iso · top
 * ทุกภาพเป็น JPEG (ไฟล์ Excel ไม่ใหญ่เกิน) และคืนมุมมอง/การแสดงผลเดิมให้ผู้ใช้หลังถ่าย */
const REPORT_SHOT_NAME = () => ({
  top: L('อุณหภูมิ มุมมองด้านบน', 'Temperature, top view'), side: L('อุณหภูมิ หน้าตัดด้านข้าง', 'Temperature, side section'),
  iso: L('อุณหภูมิ มุมมอง 3D', 'Temperature, 3D view'), suction: L('อุณหภูมิที่หน้าคอยล์ดูดลม', 'Temperature at the CDU suction'), pressure: L('ความดัน หน้าตัดด้านข้าง', 'Pressure, side section'),
});
const nextFrames = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 180))));

/** ภาพจากมุมมองปัจจุบัน: JPEG + แถบสีด้านล่าง (ถ้ามีผล) → { url, w, h } */
async function reportShot() {
  const src = new Image();
  src.src = viewer.snapshot();
  await src.decode();
  const W = src.width, s = W / 1200, ticks = colorbarTicks();
  const foot = ticks ? Math.round(62 * s) : 0;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = src.height + foot;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(src, 0, 0);
  if (ticks) {
    const x0 = 16 * s, x1 = Math.min(W - 16 * s, x0 + 620 * s), y = src.height + 10 * s, bh = 16 * s;
    const lv = viewer.display.mode === 'contour' ? CONTOUR_LEVELS : 0;
    for (let i = 0; i < 240; i++) {
      let t = i / 239;
      if (lv) t = (Math.min(lv - 1, Math.floor(t * lv)) + 0.5) / lv;
      const c = rgb(t);
      g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      g.fillRect(x0 + (x1 - x0) * i / 240, y, (x1 - x0) / 240 + 1, bh);
    }
    g.strokeStyle = '#8a98a5'; g.lineWidth = Math.max(1, s); g.strokeRect(x0, y, x1 - x0, bh);
    g.fillStyle = '#1c2a36';
    g.font = `${Math.round(13 * s)}px "IBM Plex Sans Thai", Tahoma, sans-serif`;
    g.textBaseline = 'top';
    ticks.forEach((t, i) => { g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'; g.fillText(t.txt, x0 + (x1 - x0) * t.p, y + bh + 4 * s); });
    g.textAlign = 'left';
    g.fillText(`${FIELDS[viewer.display.field].label} (${FIELDS[viewer.display.field].unit})`, x1 + 16 * s, y);
  }
  return { url: cv.toDataURL('image/jpeg', 0.86), w: cv.width, h: cv.height };
}

function saveViewState() {
  const d = viewer.display;
  return { view: viewer.view, section: { ...viewer.section }, display: { field: d.field, mode: d.mode, particles: d.particles, iso: d.iso, suction: d.suction, cduColor: d.cduColor } };
}
function restoreViewState(st) {
  viewer.setDisplay(st.display);
  viewer.setSection(st.section.axis, st.section.pos, st.section.show);
  setViewUI(st.view);
  syncSectionUI();
  $('#btn-suction')?.classList.toggle('on', st.display.suction);
}
/** ระนาบหน้าตัดที่ตำแหน่ง pos (บีบให้อยู่ในช่วงที่วางได้) */
function sectionAt(axis, pos) {
  viewer.section.axis = axis;
  const [a, b] = viewer.sectionLimits();
  viewer.setSection(axis, Math.min(b, Math.max(a, pos)), true);
}

async function captureResultShots() {
  const units = unitsNow();
  if (!units?.length) return {};
  const st = saveViewState();
  const worst = units.reduce((a, b) => (b.dT > a.dT ? b : a));
  const o = worst.obj || {};
  const hS = (o.elev || 0) + (o.model ? unitSize(o).h * 0.5 : 1);
  const out = {};
  try {
    viewer.setDisplay({ field: 'T', mode: 'contour', particles: false, iso: false, suction: false });
    setViewUI('top'); sectionAt('y', hS); await nextFrames(); out.top = await reportShot();
    setViewUI('pz'); sectionAt('z', o.z ?? 0); await nextFrames(); out.side = await reportShot();
    viewer.setDisplay({ field: 'P' }); await nextFrames(); out.pressure = await reportShot();
    viewer.setDisplay({ field: 'T', iso: st.display.iso });
    setViewUI('3d'); sectionAt('y', hS); await nextFrames(); out.iso = await reportShot();
    viewer.setSection(viewer.section.axis, viewer.section.pos, false);
    viewer.setDisplay({ iso: false, suction: true, cduColor: 'shade' }); await nextFrames(); out.suction = await reportShot();
  } finally { restoreViewState(st); }
  return out;
}

async function captureModelShots() {
  const st = saveViewState();
  const hadRes = !!(run.fields && run.mesh && !run.stale);
  const ulShow = underlay?.show;
  const out = {};
  try {
    viewer.setResults(null);
    viewer.setSection(st.section.axis, st.section.pos, false);
    viewer.setDisplay({ suction: false });
    setViewUI('top'); await nextFrames(); out.plan = await reportShot();
    if (underlay && ulShow) { underlay.show = false; applyUnderlay(); await nextFrames(); out.top = await reportShot(); underlay.show = true; applyUnderlay(); } else out.top = out.plan;
    setViewUI('pz'); await nextFrames(); out.front = await reportShot();
    setViewUI('3d'); await nextFrames(); out.iso = await reportShot();
  } finally {
    if (hadRes) pushFieldsToViewer();
    restoreViewState(st);
  }
  return out;
}

/* ───────── รายงาน Excel ตามแบบฟอร์ม (A3 board / A4 report) ───────── */
const FORM_KEY = 'cfd-form-meta';
let formMeta = { style: 'board', simBy: '', soldBy: '', company: 'SIAM DAIKIN SALES CO.,LTD.', division: 'TECHNICAL SUPPORT DIVISION', logo: null, pressure: false };
try { formMeta = { ...formMeta, ...(JSON.parse(localStorage.getItem(FORM_KEY) || 'null') || {}) }; } catch { /* ถูกบล็อก */ }
function saveFormMeta() {
  try { localStorage.setItem(FORM_KEY, JSON.stringify(formMeta)); } catch { toast(L('จำค่าไว้ในเบราว์เซอร์ไม่ได้ (โลโก้อาจใหญ่เกินไป)', 'Could not remember the settings in this browser (the logo may be too large)')); }
}
const todayTH = () => { const d = new Date(); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; };
const stripTags = h => h.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim();

/** ข้อความเงื่อนไขของแบบ (บรรทัด "- …") */
function conditionLines(sc) {
  const cdus = sc.objects.filter(o => o.type === 'cdu');
  const bySeries = new Map();
  for (const o of cdus) {
    const m = getModel(o.model), k = seriesOf(m).label;
    if (!bySeries.has(k)) bySeries.set(k, new Map());
    const mm = bySeries.get(k); mm.set(o.model, (mm.get(o.model) || 0) + 1);
  }
  const model = [...bySeries].map(([k, mm]) => `${k} (${[...mm].map(([id, n]) => `${id} × ${n}`).join(', ')})`).join(' , ');
  const lines = [`- Daikin model: ${model || '-'}`];
  const hood = [...new Set(cdus.filter(o => o.duct > 0).map(o => o.duct))];
  if (hood.length) lines.push(L(`- ติด Hood ที่ CDU ${cdus.filter(o => o.duct > 0).length} เครื่อง (${hood.map(fmt).join(', ')} ม.)`, `- Hood on ${cdus.filter(o => o.duct > 0).length} CDU(s) (${hood.map(fmt).join(', ')} m)`));
  lines.push(`- Ambient air temperature : ${sc.site.ambient} C`);
  const walls = sc.objects.filter(o => o.type === 'wall');
  const lv = [...new Set(walls.filter(o => o.louver > 0).map(o => o.louver))].sort((a, b) => a - b);
  if (walls.length) lines.push(lv.length ? `- Louver : Free area ${lv.map(v => `${fmt(v)}%`).join(', ')}` : L('- ผนังทึบ (ไม่มี Louver)', '- Solid walls (no louver)'));
  if (sc.site.windProfile && sc.site.windProfile !== 'uniform' && WIND_PROFILES[sc.site.windProfile]) lines.push(L(`- โปรไฟล์ลม: ${WIND_PROFILES[sc.site.windProfile].th} · ความสูงอ้างอิง ${sc.site.windRefH} ม. · พื้นที่วางเครื่องสูง ${sc.site.groundElev} ม. จากพื้นดิน`, `- Wind profile: ${WIND_PROFILES[sc.site.windProfile].en} · reference height ${sc.site.windRefH} m · site ${sc.site.groundElev} m above ground`));
  return lines;
}

/** ข้อความสภาพลมของผลหนึ่งชุด */
function condTexts(site, windDir) {
  const calm = !(site.windSpeed > 0) || windDir === CALM;
  if (calm) return { label: L('ลม 0.0 m/s (ไม่มีลม)', 'Wind 0.0 m/s (no wind)'), head: 'No Wind' };
  const v = Number(site.windSpeed).toFixed(1), ab = dirName(site.windDir, true);
  return { label: L(`ลม ${v} m/s พัดมาจากทิศ ${ab}`, `Wind ${v} m/s from ${ab}`), head: `Wind velocity ${v} m/s (${L(`ลมพัดมาจากทิศ${dirName(site.windDir).replace(/^ลมจากทิศ/, '').replace(/^Wind from /, '')}`, `from ${dirName(site.windDir).replace(/^Wind from /, '')}`)})` };
}

const unitRows = units => units.map(u => ({ name: u.name, Tin: u.Tin, band: unitBand(u) }));

function formStaticTexts() {
  const tmp = document.createElement('div');
  tmp.innerHTML = bandCriteriaHTML();
  const crit = [...tmp.querySelectorAll('li')].map((li, i) => ({ band: ['green', 'yellow', 'red'][i], text: li.textContent.trim() }));
  tmp.innerHTML = remarkHTML();
  const rem = [...tmp.querySelectorAll('li')].map((li, i) => `${i + 1}. ${li.textContent.trim()}`);
  const p = [...tmp.querySelectorAll('p')].map(x => x.textContent.trim()).filter(t => t && !/^REMARK/.test(t));
  return { criteria: crit, remark: [...rem, ...p] };
}

function toggleFormPop(show) {
  if (show) {
    const hasBatch = batch.results.some(r => r.ok), hasRun = !!(unitsNow() && !run.stale);
    if (!hasBatch && !hasRun) { toast(L('ยังไม่มีผล — คำนวณ หรือรัน Batch ก่อน', 'No results yet — run a calculation or a batch first')); return; }
    if (batch.active) { toast(L('รอ Batch ให้เสร็จก่อน', 'Wait for the batch to finish')); return; }
    renderFormPop(hasBatch, hasRun);
  }
  $('#form-pop').hidden = !show;
}

function renderFormPop(hasBatch, hasRun) {
  const m = formMeta;
  $(`#fm-style-${m.style === 'a4' ? 'a4' : 'board'}`).checked = true;
  $('#fm-src-batch').disabled = !hasBatch; $('#fm-src-run').disabled = !hasRun;
  (hasBatch ? $('#fm-src-batch') : $('#fm-src-run')).checked = true;
  $('#fm-project').value = (batch.results.find(r => r.ok)?.snap.name.split(' — ')[0]) || scene.name;
  $('#fm-rev').value = m.rev || '';
  $('#fm-date').value = todayTH();
  $('#fm-zone').value = '';
  for (const k of ['simBy', 'soldBy', 'company', 'division']) $(`#fm-${k}`).value = m[k] || '';
  $('#fm-pressure').checked = !!m.pressure;
  $('#fm-logo-img').hidden = !m.logo;
  if (m.logo) $('#fm-logo-img').src = m.logo.url;
  $('#fm-logo-clear').hidden = !m.logo;
  const adv = [...$$('#advice li')].map(li => li.textContent.trim()).filter(t => t && !/กด คำนวณ|Press Run/.test(t));
  $('#fm-notes').value = $('#fm-src-run').checked ? adv.join('\n') : '';
}

async function exportFormReport() {
  const m = formMeta;
  m.style = $('#fm-style-a4').checked ? 'a4' : 'board';
  for (const k of ['simBy', 'soldBy', 'company', 'division']) m[k] = $(`#fm-${k}`).value.trim();
  m.rev = $('#fm-rev').value.trim();
  m.pressure = $('#fm-pressure').checked;
  saveFormMeta();
  const fromBatch = $('#fm-src-batch').checked;
  const project = $('#fm-project').value.trim() || scene.name;
  const zone = $('#fm-zone').value.trim();
  const go = $('#fm-go');
  go.disabled = true;
  const old = go.innerHTML;
  go.textContent = L('กำลังสร้างรายงาน…', 'Building the report…');
  try {
    const { criteria, remark } = formStaticTexts();
    const options = [];
    if (fromBatch) {
      const ok = batch.results.filter(r => r.ok);
      const groups = [...new Set(ok.map(r => r.group))];
      groups.forEach((g, gi) => {
        const rs = ok.filter(r => r.group === g);
        const sc = normalizeScene(JSON.parse(rs[0].sceneJSON));
        const title = `OPTION ${gi + 1}${g ? ` — ${g}` : ''}`;
        options.push({
          title, zone: zone ? `${zone}${groups.length > 1 ? ` — Option ${gi + 1}` : ''}` : title, sheetName: `Option ${gi + 1}`,
          lines: conditionLines(sc), model: batch.model.get(g) || {},
          conds: rs.map(r => ({ ...condTexts(r.snap.site, r.windDir), shots: r.named || {}, units: unitRows(r.snap.units) })),
        });
      });
    } else {
      const model = await captureModelShots();
      const shots = await captureResultShots();
      const title = zone || 'OPTION 1';
      options.push({ title, zone: title, sheetName: zone || 'Option 1', lines: conditionLines(scene), model, conds: [{ ...condTexts(scene.site, scene.site.windSpeed > 0 ? scene.site.windDir : CALM), shots, units: unitRows(unitsNow()) }] });
    }
    const job = {
      meta: { project, date: $('#fm-date').value.trim() || todayTH(), rev: m.rev, simBy: m.simBy, soldBy: m.soldBy, company: m.company, division: m.division, logo: m.logo, pressure: m.pressure, notes: $('#fm-notes').value.trim(), criteria, remark },
      options,
    };
    const wb = buildFormReport(job, m.style);
    download(`${safeName(project)}${m.rev ? `-${safeName(m.rev)}` : ''}-CFD-${m.style === 'a4' ? 'Report-A4' : 'Board-A3'}.xlsx`, wb.toBlob(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toggleFormPop(false);
    toast(L('ดาวน์โหลดรายงาน Excel แล้ว — สั่งพิมพ์/บันทึกเป็น PDF จาก Excel ได้ (ตั้งหน้ากระดาษไว้แล้ว)', 'Excel report downloaded — print or save as PDF from Excel (page setup is ready)'), 5000);
  } catch (e) {
    toast(L('สร้างรายงานไม่ได้: ', 'Could not build the report: ') + (e.message || e), 6000);
  } finally { go.disabled = false; go.innerHTML = old; }
}

function bindFormPop() {
  for (const id of ['#btn-form', '#bt-form']) $(id)?.addEventListener('click', () => toggleFormPop(true));
  $('#form-pop .keys-x').addEventListener('click', () => toggleFormPop(false));
  $('#form-pop').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) toggleFormPop(false); });
  $('#fm-go').addEventListener('click', exportFormReport);
  $('#fm-logo').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        // ย่อโลโก้ให้สูงไม่เกิน 240 px แล้วเก็บเป็น PNG
        const k = Math.min(1, 240 / im.height), cv = document.createElement('canvas');
        cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        formMeta.logo = { url: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
        saveFormMeta();
        $('#fm-logo-img').src = formMeta.logo.url; $('#fm-logo-img').hidden = false; $('#fm-logo-clear').hidden = false;
      };
      im.src = String(rd.result);
    };
    rd.readAsDataURL(f);
  });
  $('#fm-logo-clear').addEventListener('click', () => { formMeta.logo = null; saveFormMeta(); $('#fm-logo-img').hidden = true; $('#fm-logo-clear').hidden = true; });
  $$('input[name="fm-src"]').forEach(el => el.addEventListener('change', () => {
    const adv = [...$$('#advice li')].map(li => li.textContent.trim()).filter(t => t && !/กด คำนวณ|Press Run/.test(t));
    $('#fm-notes').value = $('#fm-src-run').checked ? adv.join('\n') : '';
  }));
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

/** ข้อความเครื่องคำนวณที่แถบสถานะ — เก็บเป็นฟังก์ชันเพื่อแปลใหม่เมื่อสลับภาษา */
let footMode = () => L('คำนวณใน Web Worker', 'Runs in a Web Worker');
function setFootMode(fn) {
  if (fn) footMode = fn;
  const el = $('#foot-mode');
  el.textContent = el.title = footMode();
}

/* ───────── ภาษา (ไทย / อังกฤษ) และธีม (ตามระบบ / สว่าง / มืด) ───────── */

/** ข้อความคงที่ใน index.html: data-en = เนื้อหา, data-en-title / data-en-tip / data-en-label = attribute */
function applyStaticLang() {
  const en = getLang() === 'en';
  document.documentElement.lang = getLang();
  for (const el of $$('[data-en]')) {
    if (el._th === undefined) el._th = el.innerHTML;
    el.innerHTML = en ? el.dataset.en : el._th;
  }
  for (const [key, sel, attr] of [['enTitle', 'data-en-title', 'title'], ['enTip', 'data-en-tip', 'data-tip'], ['enLabel', 'data-en-label', 'aria-label']]) {
    for (const el of $$(`[${sel}]`)) {
      const store = '_th_' + key;
      if (el[store] === undefined) el[store] = el.getAttribute(attr) || '';
      el.setAttribute(attr, en ? el.dataset[key] : el[store]);
    }
  }
}

/** สลับภาษาแล้ววาดทุกส่วนที่สร้างข้อความจากโค้ดใหม่ (ผลการคำนวณและแบบไม่เปลี่ยน) */
function applyLang() {
  applyStaticLang();
  $$('#seg-lang button').forEach(b => b.classList.toggle('on', b.dataset.v === getLang()));
  renderPresets();
  $('#remark-body').innerHTML = remarkHTML();
  renderBatchResults();
  if (!$('#batch-pop').hidden) renderBatchPop();
  if (!$('#dxf-pop').hidden) renderDxfPop();
  viewer.refreshTexts();
  renderProps();
  renderSettings();
  renderBackend();
  setTool(tool);
  syncSectionUI();
  updateBandLegend();
  updateColorbar();
  renderResults();
  renderCompare();
  renderCaptures();
  renderModelTable();
  updateRunUI();
  setFootMode();
  showProbe(null);
  $('#d-opacity').dispatchEvent(new Event('input'));
  document.dispatchEvent(new Event('fullscreenchange'));
}

const THEME_KEY = 'cfd-theme';
let themePref = 'system';
try { const t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') themePref = t; } catch { /* ถูกบล็อก */ }
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');
const isLight = () => themePref === 'light' || (themePref === 'system' && lightQuery.matches);

function applyTheme() {
  document.documentElement.dataset.theme = isLight() ? 'light' : 'dark';
  viewer.setTheme(isLight());
  $$('#seg-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === themePref));
  drawChart(unitsNow());
  drawResiduals();
}

/** สีจากตัวแปร CSS ของธีมปัจจุบัน — ใช้กับกราฟที่วาดบน canvas */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function renderPresets() {
  $('#preset-list').innerHTML = PRESETS.filter(p => !p.group).map(p => `<button class="mi" data-preset="${p.key}"><span class="mi-t">${esc(L(p.label, p.labelEn))}</span></button>`).join('');
  // กรณีศึกษาจากคู่มือการวางคอยล์ร้อน: การ์ดละหนึ่งกรณี ภาพแบบจำลอง แบบเดิม / แบบแก้ไข พร้อมคำอธิบาย
  const cases = new Map();
  for (const p of PRESETS.filter(q => q.group === 'guide')) {
    if (!cases.has(p.caseNo)) cases.set(p.caseNo, []);
    cases.get(p.caseNo).push(p);
  }
  $('#case-grid').innerHTML = [...cases].map(([no, ps]) => `<article class="case-card">
      <h4><span class="case-no">${esc(L('กรณี', 'Case'))} ${esc(no)}</span>${esc(L(ps[0].caseTitle, ps[0].caseTitleEn))}</h4>
      <p>${esc(L(ps[0].caseDesc, ps[0].caseDescEn))}</p>
      <div class="case-pair">${ps.map(p => `<button class="case-pick ${p.variant}" data-preset="${p.key}" title="${esc(L(p.label, p.labelEn))}">
          ${CASE_THUMBS[p.key] ? `<img src="${CASE_THUMBS[p.key]}" alt="" loading="lazy" width="360" height="225">` : '<span class="case-noimg"></span>'}
          <span class="case-tag">${esc(L(p.btn, p.btnEn))}</span>
          <span class="case-cap">${esc(L(p.varDesc, p.varDescEn))}</span>
        </button>`).join('')}</div>
    </article>`).join('');
  $$('[data-preset]').forEach(b => b.addEventListener('click', () => { toggleCases(false); loadPreset(b.dataset.preset); }));
}

/* ───────── หน้า (แบบจำลอง / ผลลัพธ์ / คู่มือ) · แท็บของแผงขวา · เมนู ───────── */

function showTab(name) {
  $('#app').dataset.tab = name;
  $$('.tab').forEach(b => { b.classList.toggle('on', b.dataset.tab === name); b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
  // หน้าแบบจำลองไม่ถูกถอดออกจาก layout (ซ่อนด้วย visibility) — ภาพ 3D จึงยังถ่ายลงรายงานได้จากหน้าผลลัพธ์
  $('#tab-tool').classList.toggle('covered', name !== 'tool');
  $('#tab-results').hidden = name !== 'results';
  $('#tab-readme').hidden = name !== 'readme';
  if (name === 'tool') viewer.resize();
  if (name === 'results') { drawChart(unitsNow()); drawResiduals(); }
}

const SIDE_KEY = 'cfd-side-collapsed';
/** แท็บของแผงขวา: 'obj' วัตถุ · 'sim' ตั้งค่า · 'view' แสดงผล — expand = กางแผงถ้าถูกพับไว้ */
function showSide(name, expand = true) {
  if (expand) setSideCollapsed(false);
  $$('.stab').forEach(b => { b.classList.toggle('on', b.dataset.side === name); b.setAttribute('aria-selected', String(b.dataset.side === name)); });
  for (const k of ['obj', 'sim', 'view']) $(`#side-${k}`).hidden = k !== name;
}

function setSideCollapsed(on) {
  $('#workspace').classList.toggle('side-collapsed', on);
  try { localStorage.setItem(SIDE_KEY, on ? '1' : ''); } catch { /* ถูกบล็อก */ }
}

function closeMenus() {
  $$('.menu').forEach(m => { m.hidden = true; });
  $$('[data-menu]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

function bindMenus() {
  $$('[data-menu]').forEach(b => b.addEventListener('click', () => {
    const m = $('#' + b.dataset.menu), open = m.hidden;
    closeMenus();
    m.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
  }));
  // คลิกนอกเมนู หรือเลือกรายการแล้ว → ปิด
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.menu, [data-menu]')) closeMenus(); }, true);
  $$('.menu').forEach(m => m.addEventListener('click', (e) => { if (e.target.closest('.mi')) closeMenus(); }));
}

function loadPreset(key) {
  edit(() => { scene = presetScene(key); selectedId = null; }, true, true);
  resetResults();
  showTab('tool');
  viewer.setView(viewer.view);
  initSection();
}

function fmt(v) { return String(Math.round(v * 100) / 100); }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function fmtK(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
function fmtDur(s) {
  if (!isFinite(s)) return '–';
  if (s < 60) return L(`${Math.max(1, Math.round(s))} วินาที`, `${Math.max(1, Math.round(s))} s`);
  const tot = Math.round(s), m = Math.floor(tot / 60), r = tot % 60;
  return m >= 60 ? L(`${Math.floor(m / 60)} ชม. ${m % 60} นาที`, `${Math.floor(m / 60)} h ${m % 60} min`) : L(`${m}:${String(r).padStart(2, '0')} นาที`, `${m}:${String(r).padStart(2, '0')} min`);
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
  $$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('.stab').forEach(b => b.addEventListener('click', () => showSide(b.dataset.side)));
  $('#btn-side').addEventListener('click', () => setSideCollapsed(!$('#workspace').classList.contains('side-collapsed')));
  try { if (localStorage.getItem(SIDE_KEY) === '1') setSideCollapsed(true); } catch { /* ถูกบล็อก */ }
  bindMenus();
  $('#st-cond').addEventListener('click', () => showSide('sim'));
  $('#st-sum').addEventListener('click', () => showTab('results'));
  $$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-capture').addEventListener('click', captureView);
  $('#btn-full').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    $('#full-ic').setAttribute('href', fs ? '#i-unfull' : '#i-full');
    $('#btn-full').title = fs ? L('ออกจากเต็มจอ (Esc)', 'Exit fullscreen (Esc)') : L('เต็มจอ (Esc เพื่อออก)', 'Fullscreen (Esc to exit)');
    setTimeout(() => viewer.resize(), 60);
  });
  $('#btn-cap-all').addEventListener('click', () => captures.forEach((c, i) =>
    setTimeout(() => downloadURL(c.url, `${safeName(scene.name)}-${i + 1}.png`), i * 250)));
  $('#btn-cap-clear').addEventListener('click', () => {
    if (confirm(L(`ลบภาพที่บันทึกไว้ทั้งหมด ${captures.length} ภาพ?`, `Delete all ${captures.length} saved images?`))) { captures.length = 0; renderCaptures(); }
  });
  $$('.vt').forEach(b => b.addEventListener('click', () => setViewUI(b.dataset.view)));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-ortho').addEventListener('click', () => setOrtho(!ortho));
  $('#btn-keys').addEventListener('click', () => toggleKeys());
  $('#btn-cases').addEventListener('click', () => toggleCases(true));
  $('#cases-pop .keys-x').addEventListener('click', () => toggleCases(false));
  $('#cases-pop').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) toggleCases(false); });
  $('#keys-pop .keys-x').addEventListener('click', () => toggleKeys(false));
  $('#keys-pop').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) toggleKeys(false); });
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-run').addEventListener('click', startOrToggle);
  $('#btn-reset').addEventListener('click', () => (batch.active ? cancelBatch() : resetResults()));
  bindBatch();
  bindDxf();
  bindFormPop();
  $('#btn-edit').addEventListener('click', () => setEditUnlocked(modelLocked()));
  $('#btn-save').addEventListener('click', saveProject);
  $('#btn-open').addEventListener('click', () => $('#file-open').click());
  $('#file-open').addEventListener('change', (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; });
  $('#btn-new').addEventListener('click', () => {
    if (scene.objects.length && !confirm(L('เริ่มโปรเจกต์ใหม่? (แบบปัจจุบันยังเลิกทำกลับได้ด้วย Ctrl+Z)', 'Start a new project? (the current model can still be restored with Ctrl+Z)'))) return;
    edit(() => { scene = newScene(); selectedId = null; }, true, true);
    resetResults();
    showTab('tool');
  });
  $$('#seg-lang button').forEach(b => b.addEventListener('click', () => { setLang(b.dataset.v, true); applyLang(); }));
  $$('#seg-theme button').forEach(b => b.addEventListener('click', () => {
    themePref = b.dataset.v;
    try { localStorage.setItem(THEME_KEY, themePref); } catch { /* ถูกบล็อก */ }
    applyTheme();
  }));
  lightQuery.addEventListener('change', applyTheme);
  $('#btn-csv').addEventListener('click', exportCSV);
  $('#btn-report').addEventListener('click', () => toggleReportPop(true));
  $('#report-pop .keys-x').addEventListener('click', () => toggleReportPop(false));
  $('#report-pop').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) toggleReportPop(false); });
  $('#rep-default').addEventListener('click', () => { repOpts = defaultRepOpts(); saveRepOpts(); renderReportPop(); });
  $('#rep-go').addEventListener('click', () => { toggleReportPop(false); exportReport(); });
  $('#btn-mesh').addEventListener('click', () => toggleMesh());
  $('#btn-suction').addEventListener('click', () => toggleSuction());
  $('#btn-png').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = viewer.snapshot(); a.download = `${safeName(scene.name)}-3d.png`; a.click();
  });

  // การแสดงผล
  $('#d-field').addEventListener('change', (e) => { viewer.setDisplay({ field: e.target.value }); updateColorbar(); });
  $$('#d-cducolor button').forEach(b => b.addEventListener('click', () => setCduColor(b.dataset.v)));
  setCduColor(cduColorPref);
  $$('#d-mode button').forEach(b => b.addEventListener('click', () => {
    $$('#d-mode button').forEach(x => x.classList.toggle('on', x === b));
    viewer.setDisplay({ mode: b.dataset.v });
    // เปลี่ยนรูปแบบกราฟิก → แสดงระนาบหน้าตัดด้วย ไม่เช่นนั้นจะไม่เห็นผล
    if (!$('#d-section').checked) { $('#d-section').checked = true; viewer.setSection(viewer.section.axis, viewer.section.pos, true); }
    updateColorbar();
  }));
  const setOpacity = (v) => {
    $('#d-opacity').value = v;
    $('#d-opacity-val').textContent = `${v >= 0.999 ? L('ทึบ', 'Opaque') : L('โปร่ง', 'See-through')} ${Math.round(v * 100)}%`;
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
  bindStop();
  bindBackend();
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
    if (k === 'escape' && $$('.menu').some(m => !m.hidden)) { closeMenus(); return; }
    if (!$('#keys-pop').hidden && (k === 'escape' || k === '?')) { toggleKeys(false); return; }
    if (!$('#cases-pop').hidden) { if (k === 'escape') toggleCases(false); return; }
    if (!$('#report-pop').hidden) { if (k === 'escape') toggleReportPop(false); return; }
    if (!$('#batch-pop').hidden) { if (k === 'escape') toggleBatchPop(false); return; }
    if (!$('#dxf-pop').hidden) { if (k === 'escape') toggleDxfPop(false); return; }
    if (!$('#form-pop').hidden) { if (k === 'escape') toggleFormPop(false); return; }
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
    else if (k === 's') setTool('pull');
    else if (k === '?') toggleKeys();
    else if (k === 'tab' && (e.target === document.body || e.target.tagName === 'CANVAS')) { e.preventDefault(); cycleSelection(e.shiftKey ? -1 : 1); }
    else if (k === 'b') setTool('building');
    else if (k === 'f') setTool('slab');
    else if (k === 'p') captureView();
    else if (k === 'g') toggleMesh();
    else if (k === 'i') toggleSuction();
    else if (k >= '1' && k <= '7') setViewUI(['3d', 'n', 's', 'e', 'w', 'top', 'iso'][+k - 1]);
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
  const cat = m => CATEGORIES.find(c => c.key === seriesOf(m).cat).label;
  const rows = MODELS.map(m => `<tr><td>${cat(m)}</td><td>${seriesOf(m).label}</td><td>${m.indoor ? m.indoor + ' / ' : ''}${m.id}</td><td class="n">${seriesOf(m).cat === 'split' ? '—' : m.hp}</td><td>${m.modules.length > 1 ? m.modules.join(' + ') : '—'}</td>
    <td class="n">${m.kw.toFixed(1)}</td><td class="n">${m.cmm}</td><td class="n">${m.eer.toFixed(2)}</td>
    <td class="n">${m.width} × ${m.height} × ${m.depth}</td><td class="n">${m.fans}</td><td>${m.discharge === 'front' ? L('หน้า', 'Front') : L('บน', 'Top')}</td></tr>`).join('');
  $('#model-table').innerHTML = `<tr><th>${L('หมวด', 'Category')}</th><th>${L('ซีรีส์', 'Series')}</th><th>${L('รุ่น', 'Model')}</th><th class="n">HP</th><th>${L('โมดูล', 'Modules')}</th><th class="n">kW</th><th class="n">m³/min</th><th class="n">EER</th><th class="n">${L('ก × ส × ล (มม.)', 'W × H × D (mm)')}</th><th class="n">${L('พัดลม', 'Fans')}</th><th>${L('ลมออก', 'Discharge')}</th></tr>${rows}`;
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
renderBatchResults();
setUnderlay(loadUnderlay(), false);
applyTheme();
applyLang();
