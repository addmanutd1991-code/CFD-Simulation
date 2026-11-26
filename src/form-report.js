/*
 * form-report.js — รายงาน Excel (.xlsx) ตามแบบฟอร์ม CFD Simulation Report ของฝ่าย Technical Support
 *
 *   'board'  A3 แนวนอน หน้าเดียวต่อทางเลือก (แบบ Form01 / Form05 / Form06):
 *            หัวโครงการ · เงื่อนไข · ภาพแบบ 4 มุม · ผลแยกคอลัมน์ตามสภาพลม (top / side / isometric)
 *            · ตาราง Suction Temp. (K และ °C) · เกณฑ์สี · REMARK
 *   'a4'     A4 แนวตั้ง (แบบ Form02 / Form03 / Form04): หน้าปก + ชีตละทางเลือก
 *            1. Simulation condition · 2. Simulation model · 3. Simulation result (3.k ต่อสภาพลม: ภาพ + Table 3.k) · REMARK
 *
 * ข้อมูลเข้า (job)
 *   meta    { project, date, rev, simBy, soldBy, company, division, logo, notes, remark: [บรรทัด], criteria: [{band, text}], pressure }
 *   options [{ title, zone, lines: [ข้อความเงื่อนไข], model: { plan, front, iso, top }, conds: [cond] }]
 *   cond    { label, labelEn, head, shots: { top, side, iso, suction, pressure }, units: [{ name, Tin, band }] }
 *   ภาพ = { url (data URL PNG/JPEG), w, h } หรือ null
 */

import { Workbook } from './xlsx.js';

export const BAND_FILL = { green: null, yellow: 'FFFF00', red: 'FF0000' };
const K0 = 273.15;

/** ขนาดภาพให้พอดีกรอบ w × h โดยคงสัดส่วน */
function fit(img, w, h) {
  if (!img?.w || !img?.h) return { w, h };
  const k = Math.min(w / img.w, h / img.h);
  return { w: Math.round(img.w * k), h: Math.round(img.h * k) };
}

/** วางภาพกึ่งกลางในกรอบ (เริ่มที่แถว r คอลัมน์ c กว้าง bw สูง bh พิกเซล) */
function placeImage(ws, img, r, c, bw, bh) {
  if (!img?.url) return;
  const s = fit(img, bw, bh);
  ws.image(img.url, r, c, s.w, s.h, Math.max(0, (bw - s.w) / 2), Math.max(0, (bh - s.h) / 2));
}

const rowsFor = (px, rowPx = 20) => Math.max(1, Math.ceil(px / rowPx));

/* ───────────────────────── A3 board ───────────────────────── */

function boardSheet(wb, job, opt, idx) {
  const { meta } = job;
  const F = 'Calibri', T = 'Times New Roman';
  const ws = wb.sheet(opt.sheetName || `Option ${idx + 1}`, { paper: 'A3', landscape: true, fitWidth: 1, fitHeight: 1, margins: 0.25, zoom: 55 });
  const n = Math.max(1, opt.conds.length);
  const BC = 8, CW = 54;               // คอลัมน์ต่อหนึ่งสภาพลม · ความกว้างคอลัมน์ (px)
  const blockW = BC * CW;
  const c0 = 2, cEnd = c0 + n * BC - 1;
  ws.colPx(1, 30);
  for (let c = c0; c <= cEnd + 1; c++) ws.colPx(c, CW);
  const bold = { font: { name: F, sz: 11, b: true } };
  const txt = { font: { name: F, sz: 11 } };

  // แถบหัว: ชื่อโครงการ + วันที่
  ws.rowPt(1, 24);
  const dateC = Math.max(c0 + 1, cEnd - 3);
  const head = { font: { name: F, sz: 18, b: true }, fill: 'FFFF00', align: { v: 'center' } };
  ws.block(1, c0, 1, dateC - 1, `Project : ${meta.project}${meta.rev ? ` ${meta.rev}` : ''}`, head);
  ws.block(1, dateC, 1, cEnd, meta.date, { ...head, align: { h: 'right', v: 'center' } });

  // เงื่อนไข
  let r = 3;
  ws.rowPt(r, 21);
  ws.set(r, c0, opt.title, { font: { name: F, sz: 16, b: true } });
  r++;
  for (const line of opt.lines) { ws.set(r, c0, line, txt); r++; }
  const condEnd = r - 1;

  // ภาพแบบ 4 มุม
  r++;
  const totalW = n * blockW, quarter = Math.floor(totalW / 4), qc = Math.max(1, Math.floor(BC * n / 4));
  const views = [['plan', 'Plan Drawing'], ['front', '3D Model front view'], ['iso', '3D Model isometric view'], ['top', '3D Model top view']];
  const modelH = Math.min(300, Math.round(quarter * 0.62));
  const mRows = rowsFor(modelH + 8);
  views.forEach(([k, label], i) => {
    const cc = c0 + i * qc;
    ws.set(r, cc, label, txt);
    placeImage(ws, opt.model?.[k], r + 1, cc, Math.min(quarter, qc * CW) - 8, modelH);
  });
  const modelEnd = r + mRows;
  ws.frame(3, c0, modelEnd, cEnd, 'medium');
  ws.frame(3, 1, modelEnd, 1, 'medium');
  void condEnd;

  // ผลแยกคอลัมน์ตามสภาพลม
  r = modelEnd + 2;
  const resTop = r;
  ws.rowPt(r, 18);
  opt.conds.forEach((cd, i) => ws.block(r, c0 + i * BC, r, c0 + (i + 1) * BC - 1, cd.label, { font: { name: F, sz: 11, b: true }, align: { h: 'center', v: 'center' }, border: 'medium' }));
  r++;
  const shotH = Math.round(blockW * 0.68);
  const shotKinds = [['top', 'Temp top view'], ['side', 'Temp side view'], ['iso', 'Temp isometric view']];
  if (meta.pressure) shotKinds.push(['pressure', 'Pressure side view']);
  for (const [k, label] of shotKinds) {
    opt.conds.forEach((cd, i) => {
      ws.set(r, c0 + i * BC, label, txt);
      placeImage(ws, cd.shots?.[k], r + 1, c0 + i * BC, blockW - 8, shotH);
    });
    r += 1 + rowsFor(shotH + 8);
  }
  const resEnd = r - 1;
  ws.block(resTop, 1, resEnd, 1, 'Simulation Result', { font: { name: F, sz: 11, b: true }, align: { h: 'center', v: 'center', rot: 90 }, border: 'medium' });
  for (let i = 0; i < n; i++) ws.frame(resTop, c0 + i * BC, resEnd, c0 + (i + 1) * BC - 1, 'medium');

  // ตาราง Suction Temp.: CDU | K | °C (°C = K − 273.15)
  const tTop = r;
  const tf = { font: { name: T, sz: 10 }, align: { h: 'center', v: 'center' }, border: 'thin' };
  const nU = Math.max(1, ...opt.conds.map(cd => cd.units.length));
  opt.conds.forEach((cd, i) => {
    const b = c0 + i * BC;
    ws.block(r, b, r + 1, b + 2, 'CDU', tf);
    ws.block(r, b + 3, r, b + 7, 'Suction air temp', tf);
    ws.block(r + 1, b + 3, r + 1, b + 4, 'K', tf);
    ws.block(r + 1, b + 5, r + 1, b + 7, '°C', tf);
    cd.units.forEach((u, k) => {
      const rr = r + 2 + k;
      ws.block(rr, b, rr, b + 2, u.name, tf);
      ws.block(rr, b + 3, rr, b + 4, Math.round((u.Tin + K0) * 10) / 10, { ...tf, numFmt: '0.0' });
      const fill = BAND_FILL[u.band];
      ws.block(rr, b + 5, rr, b + 7, { f: `${colName(b + 3)}${rr}-${K0}` }, { ...tf, numFmt: '0.0', ...(fill ? { fill } : {}), ...(u.band === 'red' ? { font: { name: T, sz: 10, b: true, color: 'FFFFFF' } } : {}) });
    });
  });
  r += 2 + nU;
  ws.block(tTop, 1, r - 1, 1, 'Suction Temp.', { font: { name: F, sz: 10, b: true }, align: { h: 'center', v: 'center', rot: 90, wrap: true }, border: 'medium' });

  // เกณฑ์สี + หมายเหตุ
  r++;
  r = criteriaAndRemark(ws, meta, opt, r, c0, cEnd, F);
  return ws;
}

/** คอลัมน์เป็นตัวอักษร */
function colName(c) { let s = ''; for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }

function criteriaAndRemark(ws, meta, opt, r, c0, cEnd, F) {
  const half = c0 + Math.floor((cEnd - c0 + 1) / 2) - 1;
  const top = r;
  for (const cr of meta.criteria || []) {
    const fill = { green: '3ECF6E', yellow: 'F5C518', red: 'E5433B' }[cr.band];
    ws.set(r, c0, '', { fill, border: 'thin' });
    ws.block(r, c0 + 1, r + 1, half, cr.text, { font: { name: F, sz: 10 }, align: { v: 'top', wrap: true } });
    ws.rowPt(r, 15); r += 2;
  }
  // REMARK มาตรฐาน (ครึ่งขวา) และข้อสังเกตของงาน (ใต้เกณฑ์)
  const rem = (meta.remark || []).join('\n');
  const rr = Math.max(4, Math.ceil(rem.length / 110) + 2);
  ws.block(top, half + 1, top + rr, cEnd, `REMARK :\n${rem}`, { font: { name: F, sz: 10 }, align: { v: 'top', wrap: true }, border: 'medium' });
  r = Math.max(r, top + rr + 1) + 1;
  const notes = [opt.notes, meta.notes].filter(Boolean).join('\n');
  if (notes) {
    const nr = Math.max(2, Math.ceil(notes.length / 160) + notes.split('\n').length);
    ws.block(r, c0, r + nr, cEnd, `Remark : ${notes}`, { font: { name: F, sz: 11 }, align: { v: 'top', wrap: true }, border: 'medium' });
    r += nr + 1;
  }
  return r;
}

/* ───────────────────────── A4 report ───────────────────────── */

const A4C = 15, A4W = 64;   // คอลัมน์ A–O

function a4Base(ws) {
  ws.colPx(1, 50);
  for (let c = 2; c <= A4C; c++) ws.colPx(c, A4W);
}

function coverSheet(wb, job) {
  const { meta } = job;
  const N = 'Times New Roman';
  const ws = wb.sheet('Cover', { paper: 'A4', landscape: false, fitWidth: 1, fitHeight: 1, zoom: 85 });
  for (let c = 1; c <= 13; c++) ws.colPx(c, 64);
  if (meta.logo?.url) { const s = fit(meta.logo, 92, 113); ws.image(meta.logo.url, 1, 1, s.w, s.h, 4, 4); }
  ws.block(1, 5, 2, 13, meta.company || '', { font: { name: N, sz: 18, b: true, i: true }, align: { h: 'right', v: 'center' } });
  ws.block(3, 6, 3, 13, meta.division || '', { font: { name: N, sz: 11, b: true }, align: { h: 'right' } });
  ws.block(15, 1, 18, 13, 'CFD Simulation Report', { font: { name: N, sz: 22 }, align: { h: 'center', v: 'center' } });
  ws.block(20, 1, 21, 13, `Project name : ${meta.project}${meta.rev ? ` ${meta.rev}` : ''}`, { font: { name: N, sz: 18 }, align: { h: 'center', v: 'center', wrap: true } });
  const who = [meta.simBy && `Simulated by : ${meta.simBy}`, meta.soldBy && `Sold by : ${meta.soldBy}`, '', `Date : ${meta.date}`].filter(x => x !== null && x !== undefined && x !== false).join('\n');
  ws.block(24, 3, 28, 11, who, { font: { name: N, sz: 11 }, align: { h: 'center', v: 'top', wrap: true } });
  const rem = (meta.remark || []).join('\n');
  ws.block(40, 2, 48, 12, `REMARK :\n${rem}`, { font: { name: 'AngsanaUPC', sz: 14 }, align: { v: 'top', wrap: true }, border: 'thin' });
  ws.frame(40, 2, 48, 12, 'medium');
  return ws;
}

function a4Sheet(wb, job, opt, idx) {
  const { meta } = job;
  const A = 'AngsanaUPC';
  const ws = wb.sheet(opt.sheetName || opt.zone || `Option ${idx + 1}`, { paper: 'A4', landscape: false, fitWidth: 1, fitHeight: 0, zoom: 85 });
  a4Base(ws);
  const t = { font: { name: A, sz: 14 } };
  const b = { font: { name: A, sz: 14, b: true } };
  const green = { font: { name: A, sz: 14 }, fill: '92D050', align: { h: 'center', v: 'center' }, border: 'thin' };
  const imgW = 860;

  // หัวชีต (ซ้ำทุกทางเลือก)
  ws.rowPt(1, 21); ws.rowPt(2, 21);
  ws.block(1, 1, 2, 3, '', { border: 'thin' });
  if (meta.logo?.url) { const s = fit(meta.logo, 150, 50); ws.image(meta.logo.url, 1, 1, s.w, s.h, 4, 3); }
  ws.block(1, 4, 1, 12, 'CFD SIMULATION REPORT', green);
  ws.block(1, 13, 1, A4C, meta.rev || 'REV.0', green);
  ws.block(2, 4, 2, 12, opt.zone || opt.title, green);
  ws.block(2, 13, 2, A4C, meta.date, green);

  let r = 3;
  ws.set(r++, 1, '1. Simulation condition', b);
  for (const line of opt.lines) ws.set(r++, 1, line.replace(/^-\s*/, ''), t);
  r++;
  const fig = (label, img, h) => {
    ws.set(r, 2, label, t);
    const bh = Math.min(h, img?.w ? Math.round(imgW * img.h / img.w) : h);
    placeImage(ws, img, r + 1, 2, imgW, bh);
    r += 2 + rowsFor(bh + 6);
  };
  fig('Fig.1-1 Plan drawing', opt.model?.plan, 620);

  ws.pageBreak(r);
  ws.set(r++, 1, '2. Simulation model', b);
  r++;
  fig('Fig.2-1 Simulation model isometric view', opt.model?.iso, 420);
  fig('Fig.2-2 Simulation model top view', opt.model?.top, 420);
  fig('Fig.2-3 Simulation model front view', opt.model?.front, 300);

  ws.pageBreak(r);
  ws.set(r++, 1, '3. Simulation result', b);
  opt.conds.forEach((cd, i) => {
    const k = i + 1;
    if (i > 0) ws.pageBreak(r);
    r++;
    ws.set(r++, 2, `3.${k} Condition : ${cd.head}`, b);
    r++;
    fig(`Fig.3.${k}-1 Contour temperature top view`, cd.shots?.top, 420);
    fig(`Fig.3.${k}-2 Contour temperature section A`, cd.shots?.side, 420);
    fig(`Fig.3.${k}-3 Contour temperature at CDU suction`, cd.shots?.suction, 420);
    if (meta.pressure) fig(`Fig.3.${k}-4 Contour pressure`, cd.shots?.pressure, 420);
    // Table 3.k
    const tf = { font: { name: A, sz: 14 }, align: { h: 'center', v: 'center' }, border: 'thin' };
    ws.set(r++, 1, `Table 3.${k} Air temperature CDU suction`, t);
    ws.block(r, 1, r, 2, 'CDU', tf);
    ws.block(r, 3, r, 4, 'Suction air temp', tf);
    r++;
    ws.block(r, 1, r, 2, 'no.', tf); ws.set(r, 3, '°C', tf); ws.set(r, 4, 'K', tf);
    r++;
    for (const u of cd.units) {
      ws.block(r, 1, r, 2, u.name, tf);
      const fill = BAND_FILL[u.band];
      ws.set(r, 3, { f: `D${r}-${K0}` }, { ...tf, numFmt: '0.0', ...(fill ? { fill } : {}), ...(u.band === 'red' ? { font: { name: A, sz: 14, b: true, color: 'FFFFFF' } } : {}) });
      ws.set(r, 4, Math.round((u.Tin + K0) * 10) / 10, { ...tf, numFmt: '0.0' });
      r++;
    }
    r++;
  });

  // เกณฑ์ + REMARK ของงาน
  r++;
  for (const cr of meta.criteria || []) {
    const fill = { green: '3ECF6E', yellow: 'F5C518', red: 'E5433B' }[cr.band];
    ws.set(r, 2, '', { fill, border: 'thin' });
    ws.block(r, 3, r + 1, A4C, cr.text, { font: { name: A, sz: 14 }, align: { v: 'top', wrap: true } });
    r += 2;
  }
  const notes = [opt.notes, meta.notes].filter(Boolean).join('\n');
  if (notes) {
    r++;
    ws.rowPt(r, 27);
    ws.set(r++, 2, 'REMARK : ', { font: { name: A, sz: 20 } });
    const nr = Math.max(3, Math.ceil(notes.length / 120) + notes.split('\n').length);
    ws.block(r, 2, r + nr, A4C - 1, notes, { font: { name: A, sz: 18 }, align: { v: 'top', wrap: true } });
    r += nr + 1;
  }
  return ws;
}

/** สร้างไฟล์ทั้งเล่ม — คืน Uint8Array ของ .xlsx */
export function buildFormReport(job, style = 'board') {
  const wb = new Workbook({ font: style === 'a4' ? 'AngsanaUPC' : 'Calibri', size: style === 'a4' ? 14 : 11 });
  if (style === 'a4') {
    coverSheet(wb, job);
    job.options.forEach((o, i) => a4Sheet(wb, job, o, i));
  } else {
    job.options.forEach((o, i) => boardSheet(wb, job, o, i));
  }
  return wb;
}
