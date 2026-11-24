'use strict';

// ที่เก็บข้อมูลชั่วคราวในหน่วยความจำ ข้อมูลหายเมื่อปิดแอป
// ขั้นที่ 2 จะมี store/postgres.js ที่มีฟังก์ชันชื่อเดียวกัน server.js จึงไม่ต้องแก้

const { OPEN_HOUR, CLOSE_HOUR, StoreError } = require('./common');

const ROOMS = [
  { id: 1, code: 'L2-01', building: 'หอสมุด ชั้น 2', capacity: 4 },
  { id: 2, code: 'L2-02', building: 'หอสมุด ชั้น 2', capacity: 4 },
  { id: 3, code: 'L2-03', building: 'หอสมุด ชั้น 2', capacity: 6 },
  { id: 4, code: 'L3-01', building: 'หอสมุด ชั้น 3', capacity: 8 },
  { id: 5, code: 'L3-02', building: 'หอสมุด ชั้น 3', capacity: 12 },
];

const bySlot = new Map(); // "roomId|date|hour" -> booking
const byId = new Map();   // id -> booking
let nextId = 1;

const slotKey = (roomId, date, hour) => `${roomId}|${date}|${hour}`;

async function listRooms() {
  return ROOMS.map((r) => ({ ...r }));
}

async function getRoom(roomId) {
  const r = ROOMS.find((x) => x.id === roomId);
  return r ? { ...r } : null;
}

async function getSlots(roomId, date) {
  const slots = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    const b = bySlot.get(slotKey(roomId, date, h));
    slots.push({
      start_hour: h,
      booked: Boolean(b),
      booking_id: b ? b.id : null,
      booked_by: b ? b.booked_by : null,
    });
  }
  return slots;
}

async function createBooking({ roomId, date, startHour, bookedBy }) {
  const key = slotKey(roomId, date, startHour);
  if (bySlot.has(key)) {
    throw new StoreError('conflict', 'ช่วงเวลานี้มีคนจองแล้ว');
  }
  const booking = {
    id: nextId++,
    room_id: roomId,
    date,
    start_hour: startHour,
    booked_by: bookedBy,
    created_at: new Date().toISOString(),
  };
  bySlot.set(key, booking);
  byId.set(booking.id, booking);
  return { ...booking };
}

async function cancelBooking(id) {
  const b = byId.get(id);
  if (!b) throw new StoreError('not_found', 'ไม่พบการจองนี้');
  byId.delete(id);
  bySlot.delete(slotKey(b.room_id, b.date, b.start_hour));
}

module.exports = { listRooms, getRoom, getSlots, createBooking, cancelBooking };
