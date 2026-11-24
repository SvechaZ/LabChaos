'use strict';

// ห้องเปิด 08:00 ถึง 20:00 จองได้ครั้งละ 1 ชั่วโมง ช่องสุดท้ายคือ 19:00-20:00
const OPEN_HOUR = 8;
const CLOSE_HOUR = 20;

// จองล่วงหน้าได้ไม่เกิน 14 วัน นับวันนี้เป็นวันแรก
const BOOKING_WINDOW_DAYS = 14;

// ทุกวันที่และชั่วโมงในแอปคิดตามเวลาไทย ไม่ว่าเซิร์ฟเวอร์จะตั้งเขตเวลาไว้อย่างไร
const TZ = 'Asia/Bangkok';

function bangkokNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// รับเฉพาะ YYYY-MM-DD ที่เป็นวันที่มีอยู่จริง 2026-02-30 จะไม่ผ่าน
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// code ใช้ให้ server.js เลือกรหัส HTTP: not_found -> 404, conflict -> 409
class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = {
  OPEN_HOUR, CLOSE_HOUR, BOOKING_WINDOW_DAYS, TZ,
  bangkokNow, addDays, isValidDate, StoreError,
};
