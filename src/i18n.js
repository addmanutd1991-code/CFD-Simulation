/*
 * i18n.js — ภาษาของหน้าจอ (ไทย / อังกฤษ)
 *
 *   L('ข้อความไทย', 'English text')  คืนข้อความตามภาษาปัจจุบัน
 * ข้อความคงที่ใน index.html ใช้ attribute data-en / data-en-title / data-en-tip (ดู applyStaticLang ใน main.js)
 * ค่าเริ่มต้น: ที่ผู้ใช้เลือกไว้ (localStorage) → ภาษาของเบราว์เซอร์ (ไม่ใช่ไทย = อังกฤษ)
 * ใช้ได้ทั้งหน้าเว็บ, Web Worker (รับภาษาจากคำสั่ง init) และ Node (selftest)
 */

const KEY = 'cfd-lang';

function detect() {
  try {
    const s = globalThis.localStorage?.getItem(KEY);
    if (s === 'th' || s === 'en') return s;
  } catch { /* ถูกบล็อก หรือไม่มี localStorage */ }
  return /^th/i.test(globalThis.navigator?.language || 'th') ? 'th' : 'en';
}

let lang = detect();

export const getLang = () => lang;

/** ตั้งภาษา — save = จำไว้กับเบราว์เซอร์ */
export function setLang(l, save = false) {
  lang = l === 'en' ? 'en' : 'th';
  if (save) { try { globalThis.localStorage?.setItem(KEY, lang); } catch { /* ถูกบล็อก */ } }
}

export const L = (th, en) => (lang === 'en' ? en : th);
