/*
 * xlsx.js — เขียนไฟล์ Excel (.xlsx) ในเบราว์เซอร์โดยไม่ใช้ไลบรารีภายนอก
 *
 * รองรับเท่าที่รายงานต้องใช้: ข้อความ / ตัวเลข / สูตร · รูปแบบเซลล์ (ฟอนต์ สีพื้น เส้นขอบ จัดวาง ตัดบรรทัด รูปแบบตัวเลข)
 * · ผสานเซลล์ · ความกว้างคอลัมน์ / ความสูงแถว · รูปภาพ (PNG / JPEG) วางที่มุมเซลล์ตามขนาดพิกเซล
 * · ตั้งหน้ากระดาษ (A3 / A4, แนวตั้ง / แนวนอน, ย่อพอดีความกว้าง) · ตัดหน้า · ซ่อนเส้นตาราง
 * ไฟล์ zip แบบไม่บีบอัด (store) — รูปเป็น JPEG/PNG ที่บีบอัดอยู่แล้ว ขนาดไฟล์จึงใกล้เคียงกัน
 *
 * ใช้งาน
 *   const wb = new Workbook();
 *   const ws = wb.sheet('Report', { paper: 'A4', landscape: false });
 *   ws.colPx(1, 60); ws.rowPt(1, 24);
 *   ws.set(1, 1, 'ข้อความ', { font: { b: true, sz: 14 }, fill: 'FFFF00', border: 'thin' });
 *   ws.set(2, 3, { f: 'B2-273.15' }, { numFmt: '0.0' });
 *   ws.merge(1, 1, 1, 6);
 *   ws.image(dataURL, 3, 1, 400, 300);
 *   const blob = wb.toBlob();
 * แถว/คอลัมน์นับจาก 1
 */

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU = 9525;   // EMU ต่อพิกเซล (96 dpi)

const xe = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // อักขระควบคุมที่ XML 1.0 ไม่อนุญาต
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** A1 จาก (แถว, คอลัมน์) */
export function ref(r, c) {
  let s = '';
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s + r;
}

/** ความกว้างคอลัมน์ (หน่วยตัวอักษรของ Excel) จากพิกเซล — ฟอนต์มาตรฐาน 11 pt ≈ 7 px ต่อตัวอักษร + ขอบ 5 px */
export const pxToWidth = px => Math.max(0.1, Math.round(((px - 5) / 7) * 100) / 100);
export const widthToPx = w => Math.floor(w * 7 + 5);

class Sheet {
  constructor(wb, name, opt) {
    this.wb = wb;
    this.name = name;
    this.opt = { paper: 'A4', landscape: false, fitWidth: 1, fitHeight: 0, margins: 0.4, gridLines: false, defaultColPx: 64, defaultRowPt: 15, zoom: 85, ...opt };
    this.cells = new Map();   // r → Map(c → {v, s})
    this.cols = new Map();    // c → px
    this.rows = new Map();    // r → pt
    this.merges = [];
    this.images = [];
    this.breaks = [];
  }

  colPx(c, px) { this.cols.set(c, px); return this; }
  rowPt(r, pt) { this.rows.set(r, pt); return this; }
  colWidthPx(c) { return this.cols.get(c) ?? this.opt.defaultColPx; }
  rowHeightPx(r) { return Math.round((this.rows.get(r) ?? this.opt.defaultRowPt) * 4 / 3); }

  /** v: string | number | { f: 'สูตรไม่มี =' } | null · style ดู Workbook.styleId */
  set(r, c, v, style) {
    if (!this.cells.has(r)) this.cells.set(r, new Map());
    this.cells.get(r).set(c, { v, s: style ? this.wb.styleId(style) : 0, st: style || null });
    return this;
  }

  /** ใส่รูปแบบให้ทุกเซลล์ในช่วง (ไม่ทับค่าที่มีอยู่) — ใช้วาดกรอบรอบพื้นที่ผสานเซลล์ */
  styleRange(r1, c1, r2, c2, style) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const row = this.cells.get(r);
      const old = row?.get(c);
      this.set(r, c, old ? old.v : null, style);
    }
    return this;
  }

  /** กรอบเส้นรอบช่วง (เฉพาะขอบนอก) — รวมกับรูปแบบเดิมของเซลล์ */
  frame(r1, c1, r2, c2, w = 'thin') {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const b = {};
      if (r === r1) b.t = w;
      if (r === r2) b.b = w;
      if (c === c1) b.l = w;
      if (c === c2) b.r = w;
      if (!Object.keys(b).length) continue;
      const old = this.cells.get(r)?.get(c);
      const st = old?.st || {};
      const ob = typeof st.border === 'string' ? { l: st.border, r: st.border, t: st.border, b: st.border } : (st.border || {});
      this.set(r, c, old ? old.v : null, { ...st, border: { ...ob, ...b } });
    }
    return this;
  }

  merge(r1, c1, r2, c2) { if (r2 > r1 || c2 > c1) this.merges.push([r1, c1, r2, c2]); return this; }

  /** ผสานและใส่ค่าพร้อมรูปแบบทั้งช่วง (เส้นขอบครบทุกเซลล์ของช่วง) */
  block(r1, c1, r2, c2, v, style) {
    this.styleRange(r1, c1, r2, c2, style);
    this.set(r1, c1, v, style);
    this.merge(r1, c1, r2, c2);
    return this;
  }

  /** รูปภาพจาก data URL วางที่มุมบนซ้ายของเซลล์ (r, c) + ระยะเลื่อน dx/dy พิกเซล ขนาด w × h พิกเซล */
  image(dataURL, r, c, w, h, dx = 0, dy = 0) {
    const id = this.wb.media(dataURL);
    if (id) this.images.push({ id, r, c, w: Math.round(w), h: Math.round(h), dx: Math.round(dx), dy: Math.round(dy) });
    return this;
  }

  /** ตัดหน้าก่อนแถว r */
  pageBreak(r) { if (r > 1) this.breaks.push(r - 1); return this; }

  xml(drawRid) {
    const o = this.opt;
    let maxR = 1, maxC = 1;
    for (const [r, row] of this.cells) for (const c of row.keys()) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
    const out = [XML, `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}">`,
      `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`,
      `<dimension ref="A1:${ref(maxR, maxC)}"/>`,
      `<sheetViews><sheetView workbookViewId="0"${o.gridLines ? '' : ' showGridLines="0"'} zoomScale="${o.zoom}" zoomScaleNormal="${o.zoom}"/></sheetViews>`,
      `<sheetFormatPr defaultRowHeight="${o.defaultRowPt}" customHeight="1"/>`];
    const cs = [...this.cols].sort((a, b) => a[0] - b[0]);
    if (cs.length) out.push('<cols>' + cs.map(([c, px]) => `<col min="${c}" max="${c}" width="${pxToWidth(px)}" customWidth="1"/>`).join('') + '</cols>');
    out.push('<sheetData>');
    const rows = new Set([...this.cells.keys(), ...this.rows.keys()]);
    for (const r of [...rows].sort((a, b) => a - b)) {
      // ความสูงตายตัวทุกแถว — ไม่ให้แถวขยายตามขนาดฟอนต์ ตำแหน่งรูปที่คำนวณจากความสูงแถวจึงไม่เลื่อน
      const ht = this.rows.get(r) ?? o.defaultRowPt;
      const cells = this.cells.get(r);
      out.push(`<row r="${r}" ht="${ht}" customHeight="1">`);
      if (cells) for (const c of [...cells.keys()].sort((a, b) => a - b)) {
        const { v, s } = cells.get(c);
        const a = `r="${ref(r, c)}"${s ? ` s="${s}"` : ''}`;
        if (v == null || v === '') out.push(`<c ${a}/>`);
        else if (typeof v === 'number') out.push(isFinite(v) ? `<c ${a}><v>${v}</v></c>` : `<c ${a}/>`);
        else if (typeof v === 'object' && v.f) out.push(`<c ${a}><f>${xe(v.f)}</f></c>`);
        else out.push(`<c ${a} t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`);
      }
      out.push('</row>');
    }
    out.push('</sheetData>');
    if (this.merges.length) out.push(`<mergeCells count="${this.merges.length}">` + this.merges.map(([r1, c1, r2, c2]) => `<mergeCell ref="${ref(r1, c1)}:${ref(r2, c2)}"/>`).join('') + '</mergeCells>');
    out.push(`<printOptions horizontalCentered="1"/>`);
    const m = o.margins;
    out.push(`<pageMargins left="${m}" right="${m}" top="${m}" bottom="${m}" header="0.2" footer="0.2"/>`);
    out.push(`<pageSetup paperSize="${o.paper === 'A3' ? 8 : 9}" orientation="${o.landscape ? 'landscape' : 'portrait'}" fitToWidth="${o.fitWidth}" fitToHeight="${o.fitHeight}"/>`);
    if (this.breaks.length) out.push(`<rowBreaks count="${this.breaks.length}" manualBreakCount="${this.breaks.length}">` + this.breaks.map(r => `<brk id="${r}" max="16383" man="1"/>`).join('') + '</rowBreaks>');
    if (drawRid) out.push(`<drawing r:id="${drawRid}"/>`);
    out.push('</worksheet>');
    return out.join('');
  }

  drawingXml() {
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const parts = this.images.map((im, k) => {
      // เลื่อนจุดยึดไปตามคอลัมน์/แถวถ้าระยะเลื่อนเกินขนาดเซลล์ (Excel ต้องการ offset ภายในเซลล์)
      let c = im.c, r = im.r, dx = im.dx, dy = im.dy;
      while (dx >= this.colWidthPx(c)) { dx -= this.colWidthPx(c); c++; }
      while (dy >= this.rowHeightPx(r)) { dy -= this.rowHeightPx(r); r++; }
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>${c - 1}</xdr:col><xdr:colOff>${dx * EMU}</xdr:colOff><xdr:row>${r - 1}</xdr:row><xdr:rowOff>${dy * EMU}</xdr:rowOff></xdr:from>`
        + `<xdr:ext cx="${im.w * EMU}" cy="${im.h * EMU}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 2}" name="Picture ${k + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
        + `<xdr:blipFill><a:blip r:embed="rId${k + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
        + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${im.w * EMU}" cy="${im.h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    });
    return XML + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${A}" xmlns:r="${NS_R}">${parts.join('')}</xdr:wsDr>`;
  }

  drawingRels() {
    return XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + this.images.map((im, k) => `<Relationship Id="rId${k + 1}" Type="${REL}/image" Target="../media/${this.wb.mediaList[im.id - 1].name}"/>`).join('') + '</Relationships>';
  }
}

export class Workbook {
  constructor({ font = 'Calibri', size = 11 } = {}) {
    this.sheets = [];
    this.baseFont = { name: font, sz: size };
    this.fonts = [this.#fontXml({})];
    this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    this.numFmts = [];
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.xfKey = new Map([['{}', 0]]);
    this.mediaList = [];
    this.mediaKey = new Map();
  }

  sheet(name, opt) {
    // ชื่อชีตของ Excel: ≤ 31 ตัว ห้าม : \ / ? * [ ] และห้ามซ้ำ
    let n = String(name).replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Sheet';
    const base = n;
    for (let k = 2; this.sheets.some(s => s.name.toLowerCase() === n.toLowerCase()); k++) n = `${base.slice(0, 27)} (${k})`;
    const s = new Sheet(this, n, opt);
    this.sheets.push(s);
    return s;
  }

  #fontXml(f) {
    const F = { ...this.baseFont, ...f };
    return `<font>${F.b ? '<b/>' : ''}${F.i ? '<i/>' : ''}${F.u ? '<u/>' : ''}<sz val="${F.sz}"/>${F.color ? `<color rgb="FF${F.color}"/>` : '<color theme="1"/>'}<name val="${xe(F.name)}"/><family val="2"/></font>`;
  }

  #idx(list, x) { let i = list.indexOf(x); if (i < 0) { list.push(x); i = list.length - 1; } return i; }

  /**
   * style = { font: {name, sz, b, i, u, color:'RRGGBB'}, fill: 'RRGGBB', border: 'thin'|'medium'|{l,r,t,b},
   *           align: {h:'left'|'center'|'right', v:'top'|'center'|'bottom', wrap:true, rot:90}, numFmt: '0.0' }
   */
  styleId(st) {
    const key = JSON.stringify(st);
    if (this.xfKey.has(key)) return this.xfKey.get(key);
    const fontId = st.font ? this.#idx(this.fonts, this.#fontXml(st.font)) : 0;
    const fillId = st.fill ? this.#idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${st.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    let borderId = 0;
    if (st.border) {
      const b = typeof st.border === 'string' ? { l: st.border, r: st.border, t: st.border, b: st.border } : st.border;
      const e = (tag, w) => (w ? `<${tag} style="${w}"><color auto="1"/></${tag}>` : `<${tag}/>`);
      borderId = this.#idx(this.borders, `<border>${e('left', b.l)}${e('right', b.r)}${e('top', b.t)}${e('bottom', b.b)}<diagonal/></border>`);
    }
    let numFmtId = 0;
    if (st.numFmt) {
      const builtin = { '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '@': 49 }[st.numFmt];
      if (builtin != null) numFmtId = builtin;
      else {
        let i = this.numFmts.indexOf(st.numFmt);
        if (i < 0) { this.numFmts.push(st.numFmt); i = this.numFmts.length - 1; }
        numFmtId = 164 + i;
      }
    }
    const a = st.align;
    const align = a ? `<alignment${a.h ? ` horizontal="${a.h}"` : ''}${a.v ? ` vertical="${a.v}"` : ''}${a.wrap ? ' wrapText="1"' : ''}${a.rot ? ` textRotation="${a.rot}"` : ''}/>` : '';
    const xf = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1"' : ''}>${align}</xf>`;
    this.xfs.push(xf);
    const id = this.xfs.length - 1;
    this.xfKey.set(key, id);
    return id;
  }

  /** เก็บรูป (data URL ของ PNG / JPEG) — คืนหมายเลข (เริ่ม 1) หรือ 0 ถ้าไม่ใช่รูปที่รองรับ */
  media(dataURL) {
    if (this.mediaKey.has(dataURL)) return this.mediaKey.get(dataURL);
    const m = /^data:image\/(png|jpe?g);base64,(.*)$/.exec(dataURL || '');
    if (!m) return 0;
    const ext = m[1] === 'png' ? 'png' : 'jpeg';
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    this.mediaList.push({ name: `image${this.mediaList.length + 1}.${ext}`, bytes });
    const id = this.mediaList.length;
    this.mediaKey.set(dataURL, id);
    return id;
  }

  stylesXml() {
    return XML + `<styleSheet xmlns="${NS_MAIN}">`
      + (this.numFmts.length ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xe(f)}"/>`).join('')}</numFmts>` : '')
      + `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>`
      + `<fills count="${this.fills.length}">${this.fills.join('')}</fills>`
      + `<borders count="${this.borders.length}">${this.borders.join('')}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }

  /** ไฟล์ทั้งหมดใน zip: [{ name, data: string | Uint8Array }] */
  files() {
    const f = [];
    const ws = this.sheets;
    const ct = [XML, '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="png" ContentType="image/png"/>',
      '<Default Extension="jpeg" ContentType="image/jpeg"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'];
    ws.forEach((s, i) => {
      ct.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
      if (s.images.length) ct.push(`<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    });
    ct.push('</Types>');
    f.push({ name: '[Content_Types].xml', data: ct.join('') });
    f.push({ name: '_rels/.rels', data: XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>` });
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    f.push({ name: 'docProps/core.xml', data: XML + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>CDU Airflow CFD</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` });
    f.push({ name: 'docProps/app.xml', data: XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>CDU Airflow CFD</Application></Properties>' });
    f.push({ name: 'xl/workbook.xml', data: XML + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><bookViews><workbookView/></bookViews><sheets>${ws.map((s, i) => `<sheet name="${xe(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` });
    f.push({ name: 'xl/_rels/workbook.xml.rels', data: XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ws.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${ws.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>` });
    ws.forEach((s, i) => {
      const hasImg = s.images.length > 0;
      f.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml(hasImg ? 'rId1' : null) });
      if (hasImg) {
        f.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>` });
        f.push({ name: `xl/drawings/drawing${i + 1}.xml`, data: s.drawingXml() });
        f.push({ name: `xl/drawings/_rels/drawing${i + 1}.xml.rels`, data: s.drawingRels() });
      }
    });
    f.push({ name: 'xl/styles.xml', data: this.stylesXml() });
    for (const m of this.mediaList) f.push({ name: `xl/media/${m.name}`, data: m.bytes });
    return f;
  }

  toBytes() { return zipStore(this.files()); }
  toBlob() { return new Blob([this.toBytes()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); }
}

/* ───────── zip แบบไม่บีบอัด ───────── */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
