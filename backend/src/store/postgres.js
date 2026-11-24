'use strict';

// ที่เก็บข้อมูลใน PostgreSQL มีฟังก์ชันชื่อเดียวกับ memory.js
// ตั้งค่าการเชื่อมต่อผ่านตัวแปร PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE ที่ pg อ่านเอง

const { Pool, types } = require('pg');
const { OPEN_HOUR, CLOSE_HOUR, StoreError } = require('./common');

// pg แปลงคอลัมน์ date เป็น Date ตามเขตเวลาของเครื่อง ทำให้วันที่เลื่อนได้
// ให้คืนเป็นข้อความ YYYY-MM-DD ตามที่เก็บไว้แทน (1082 คือรหัสชนิด date)
types.setTypeParser(1082, (v) => v);

// ทุกเวลาตั้งให้สั้นกว่า 8 วินาทีที่หน้าเว็บรอ ฐานข้อมูลช้าหรือล่มจะได้ตอบ 502 ก่อนหน้าเว็บตัดเอง
const pool = new Pool({
  max: Number(process.env.PG_POOL_MAX || 10),
  connectionTimeoutMillis: 2000,  // รอ connection ว่างหรือต่อใหม่ได้ไม่เกิน 2 วินาที
  idleTimeoutMillis: 30000,
  statement_timeout: 3000,        // ฐานข้อมูลยกเลิก query ที่นานเกิน 3 วินาทีเอง
  query_timeout: 4000,            // ฝั่ง Node เลิกรอถ้าไม่ได้คำตอบใน 4 วินาที
});

// connection ที่ว่างอยู่ใน pool ขาดตอนฐานข้อมูลถูกปิด ถ้าไม่ดัก process จะล้ม
pool.on('error', (err) => {
  console.error('postgres idle client error:', err.message);
});

// error ที่แปลว่าติดต่อฐานข้อมูลไม่ได้หรือช้าเกิน ไม่ใช่โค้ดผิด
const UNAVAILABLE_SQLSTATE = /^(08|53|57P0[1-3])/; // connection, ทรัพยากรหมด, ฐานข้อมูลกำลังปิด
const UNAVAILABLE_NODE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH']);
const UNAVAILABLE_MESSAGE = /timeout exceeded when trying to connect|Query read timeout|Connection terminated/i;

function translate(err) {
  if (err instanceof StoreError) return err;
  // class 22 คือค่าข้อมูลใช้ไม่ได้ เช่นตัวเลขเกินขนาด server.js กรองไว้แล้ว
  // ตรงนี้กันอีกชั้น ถ้ามีกรณีหลุดมา ผู้ใช้จะได้ 400 ไม่ใช่ 500 ที่นับเป็นความผิดของเรา
  if (/^22/.test(err.code || '')) return new StoreError('bad_input', 'ค่าที่ส่งมาไม่ถูกต้อง');
  if (err.code === '57014') return new StoreError('unavailable', 'ฐานข้อมูลตอบช้าเกินกำหนด');
  if (UNAVAILABLE_NODE.has(err.code) || UNAVAILABLE_SQLSTATE.test(err.code || '')
      || UNAVAILABLE_MESSAGE.test(err.message || '')) {
    return new StoreError('unavailable', 'ติดต่อฐานข้อมูลไม่ได้');
  }
  return err; // อย่างอื่นคือบั๊ก ให้เป็น 500
}

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    throw translate(err);
  }
}

async function listRooms() {
  const r = await query('SELECT id, code, building, capacity FROM rooms ORDER BY id');
  return r.rows;
}

async function getRoom(roomId) {
  const r = await query('SELECT id, code, building, capacity FROM rooms WHERE id = $1', [roomId]);
  return r.rows[0] || null;
}

async function getSlots(roomId, date) {
  const r = await query(
    'SELECT id, start_hour, booked_by FROM bookings WHERE room_id = $1 AND date = $2',
    [roomId, date],
  );
  const byHour = new Map(r.rows.map((b) => [b.start_hour, b]));
  const slots = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    const b = byHour.get(h);
    slots.push({
      start_hour: h,
      booked: Boolean(b),
      booking_id: b ? Number(b.id) : null,
      booked_by: b ? b.booked_by : null,
    });
  }
  return slots;
}

async function createBooking({ roomId, date, startHour, bookedBy }) {
  try {
    const r = await pool.query(
      `INSERT INTO bookings (room_id, date, start_hour, booked_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, room_id, date, start_hour, booked_by, created_at`,
      [roomId, date, startHour, bookedBy],
    );
    const b = r.rows[0];
    return { ...b, id: Number(b.id), created_at: b.created_at.toISOString() };
  } catch (err) {
    if (err.code === '23505') throw new StoreError('conflict', 'ช่วงเวลานี้มีคนจองแล้ว');
    if (err.code === '23503') throw new StoreError('not_found', 'ไม่พบห้องนี้');
    throw translate(err);
  }
}

async function cancelBooking(id) {
  const r = await query('DELETE FROM bookings WHERE id = $1', [id]);
  if (r.rowCount === 0) throw new StoreError('not_found', 'ไม่พบการจองนี้');
}

// ใช้ใน /readyz เช็กว่ายังคุยกับฐานข้อมูลได้
async function ping() {
  await query('SELECT 1');
}

async function close() {
  await pool.end();
}

module.exports = { listRooms, getRoom, getSlots, createBooking, cancelBooking, ping, close };
