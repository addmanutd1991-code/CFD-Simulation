/*
 * batch.js — รันหลายทางเลือกต่อกันอัตโนมัติ (batch) : สร้างรายการ case จากแบบตั้งต้น + ตัวแปรที่ปรับ
 *
 * ตัวแปร (vars) แต่ละตัว = { kind, target, values }
 *   kind   'louver'  % พื้นที่เปิดของผนัง/louver  (target = id ผนัง หรือ 'all' = ทุกผนังที่เป็น louver อยู่แล้ว)
 *          'wallH'   ความสูงผนัง (ม.)              (target = id ผนัง หรือ 'all' = ทุกผนัง)
 *          'hood'    Hood (ม.) — รุ่นเป่าขึ้น = ความสูง Hood, รุ่นเป่าหน้า = ความยาว Hood (0 = ไม่มี)
 *                                                  (target = id CDU หรือ 'all')
 *          'elev'    ระยะยกฐานเครื่องเหนือผิวรองรับ (ม. — พื้น หรือแผ่นพื้น/หลังคาที่เครื่องวางอยู่)  (target = id CDU หรือ 'all')
 *          'wind'    ทิศลม (องศา "พัดมาจาก")       values = [0, 90, 180, 270] และ speed (m/s)
 * case = ผลคูณคาร์ทีเซียนของค่าทุกตัวแปร (ทิศลมวนเร็วสุด เพื่อให้ case ของลม 4 ทิศอยู่ติดกัน)
 */

import { L } from './i18n.js';
import { insideRect } from './scene.js';

/** ระดับผิวรองรับ (แผ่นพื้น/หลังคา) ใต้จุด x, z */
const supportAt = (sc, x, z) => sc.objects.filter(s => s.type === 'slab' && insideRect(s, x, z)).reduce((m, s) => Math.max(m, s.y), 0);

export const BATCH_KINDS = ['louver', 'hood', 'wallH', 'elev', 'wind'];
export const MAX_CASES = 48;
export const WIND4 = [0, 90, 180, 270];

export const KIND_INFO = () => ({
  louver: { label: L('% เปิดของ louver / ระแนง', 'Louver / screen open %'), unit: '%', objType: 'wall', allLabel: L('ทุกผนังที่เป็น louver', 'All louvred walls'), def: '50, 70, 90' },
  hood: { label: L('Hood (ความสูง / ความยาว)', 'Hood (height / length)'), unit: L('ม.', 'm'), objType: 'cdu', allLabel: L('ทุก CDU', 'All CDUs'), def: '0.5, 1.0, 1.5' },
  wallH: { label: L('ความสูงผนัง', 'Wall height'), unit: L('ม.', 'm'), objType: 'wall', allLabel: L('ทุกผนัง', 'All walls'), def: '1.8, 2.4, 3.0' },
  elev: { label: L('ยกฐานเครื่องเหนือพื้นรองรับ', 'Raise unit base above its support'), unit: L('ม.', 'm'), objType: 'cdu', allLabel: L('ทุก CDU', 'All CDUs'), def: '0.2, 0.6, 1.0' },
  wind: { label: L('ทิศลม 4 ทิศ', 'Wind, 4 directions'), unit: '°', objType: null, allLabel: '', def: '' },
});

/** ชื่อทิศลมจากองศา "พัดมาจาก" */
export function dirName(deg, short = false) {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  const th = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
  const en = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'];
  const ab = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return short ? ab[i] : L(`ลมจากทิศ${th[i]} (${ab[i]})`, `Wind from ${en[i]} (${ab[i]})`);
}

/** แปลงข้อความ "50, 70, 90" เป็นรายการตัวเลข (ตัดค่าซ้ำ) */
export function parseValues(text) {
  const out = [];
  for (const t of String(text).split(/[,;\s/]+/)) {
    const v = parseFloat(t);
    if (isFinite(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** ชื่อเป้าหมายของตัวแปร */
function targetName(scene, v) {
  if (v.kind === 'wind' || v.target === 'all') return '';
  const o = scene.objects.find(x => x.id === Number(v.target));
  return o ? ` ${o.name}` : '';
}

/** วัตถุที่ตัวแปรนี้ปรับ */
export function targetsOf(scene, v) {
  const info = KIND_INFO()[v.kind];
  if (!info?.objType) return [];
  const objs = scene.objects.filter(o => o.type === info.objType);
  if (v.target !== 'all') return objs.filter(o => o.id === Number(v.target));
  if (v.kind === 'louver') return objs.filter(o => o.louver > 0);
  return objs;
}

/** ปรับฉาก (สำเนา) ตามค่าของตัวแปรหนึ่งตัว */
function applyVar(scene, v, val, windSpeed) {
  if (v.kind === 'wind') { scene.site.windDir = val; scene.site.windSpeed = windSpeed; return; }
  for (const o of targetsOf(scene, v)) {
    if (v.kind === 'louver') o.louver = Math.min(100, Math.max(0, val));
    else if (v.kind === 'wallH') o.height = Math.max(0.1, val);
    else if (v.kind === 'hood') o.duct = Math.max(0, val);
    else if (v.kind === 'elev') o.elev = Math.round((supportAt(scene, o.x, o.z) + Math.max(0, val)) * 1000) / 1000;   // ยกจากผิวรองรับ
  }
}

/** ข้อความสั้นของค่าตัวแปรหนึ่งตัวใน case */
export function varLabel(scene, v, val) {
  if (v.kind === 'wind') return dirName(val);
  const info = KIND_INFO()[v.kind];
  const name = { louver: 'Louver', hood: 'Hood', wallH: L('ผนังสูง', 'Wall'), elev: L('ฐานเครื่อง', 'Base') }[v.kind];
  return `${name}${targetName(scene, v)} ${val}${info.unit === '%' ? '%' : ` ${info.unit}`}`;
}

/** ตรวจตัวแปรก่อนสร้าง case — คืนข้อความผิดพลาด หรือ '' */
export function validateVars(scene, vars, windSpeed) {
  if (!vars.length) return L('ยังไม่ได้เลือกตัวแปรที่จะปรับ', 'No variable selected yet');
  for (const v of vars) {
    const info = KIND_INFO()[v.kind];
    if (!v.values.length) return L(`${info.label}: ยังไม่มีค่าที่จะลอง`, `${info.label}: no values to try`);
    if (v.kind === 'wind') { if (!(windSpeed > 0)) return L('ทิศลม 4 ทิศ: ต้องกำหนดความเร็วลมมากกว่า 0', 'Wind, 4 directions: the wind speed must be above 0'); continue; }
    if (!targetsOf(scene, v).length) return L(`${info.label}: ไม่พบวัตถุที่จะปรับ`, `${info.label}: no object to change`);
  }
  return '';
}

/**
 * สร้างรายการ case: [{ no, label, parts: [{kind, val, text}], sceneJSON }]
 * baseScene ไม่ถูกแก้ — แต่ละ case เป็นสำเนา JSON
 */
export function buildCases(baseScene, vars, windSpeed) {
  // ทิศลมวนเร็วสุด (ไว้ท้ายสุด) → case ลม 4 ทิศของทางเลือกเดียวกันอยู่ติดกัน
  const ord = [...vars.filter(v => v.kind !== 'wind'), ...vars.filter(v => v.kind === 'wind')];
  let combos = [[]];
  for (const v of ord) combos = combos.flatMap(c => v.values.map(val => [...c, { v, val }]));
  const baseJSON = JSON.stringify(baseScene);
  return combos.map((c, i) => {
    const s = JSON.parse(baseJSON);
    for (const { v, val } of c) applyVar(s, v, val, windSpeed);
    const parts = c.map(({ v, val }) => ({ kind: v.kind, val, text: varLabel(baseScene, v, val) }));
    // กลุ่ม = ค่าของตัวแปรที่ไม่ใช่ทิศลม (ใช้รวมตารางลม 4 ทิศ)
    const group = parts.filter(p => p.kind !== 'wind').map(p => p.text).join(' · ');
    const label = parts.map(p => p.text).join(' · ');
    s.name = `${baseScene.name} — Case ${i + 1}: ${label}`;
    return { no: i + 1, label, group, parts, windDir: s.site.windDir, sceneJSON: JSON.stringify(s) };
  });
}
