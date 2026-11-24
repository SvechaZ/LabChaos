'use strict';

// roombook: ระบบจองห้องติว
//   /            หน้าเว็บ (roombook/public)
//   /api/...     API ที่หน้าเว็บเรียก และเป็น user journey ที่วัด SLO
//   /healthz     สำหรับ healthcheck และ docker
//   /version     เวอร์ชันที่รันอยู่

const path = require('path');
const express = require('express');
const { version: VERSION } = require('../package.json');
const {
  OPEN_HOUR, CLOSE_HOUR, BOOKING_WINDOW_DAYS,
  bangkokNow, addDays, isValidDate,
} = require('./store/common');
const store = require('./store/memory');

const SERVICE = 'roombook';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const STARTED_AT = Date.now();
const NAME_MAX = 40;

const app = express();
app.disable('x-powered-by');

// healthcheck.sh ของแล็บเทียบเวอร์ชันจาก header นี้กับ /version
app.use((req, res, next) => {
  res.set('X-App-Version', VERSION);
  next();
});

// ---------------------------------------------------------------- หน้าเว็บ
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/fonts', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource'), {
  maxAge: '30d',
  immutable: true,
}));

// ---------------------------------------------------------------- ระบบ
app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: VERSION });
});

app.get('/version', (req, res) => {
  res.json({
    service: SERVICE,
    version: VERSION,
    uptime_seconds: Math.round((Date.now() - STARTED_AT) / 100) / 10,
  });
});

// ---------------------------------------------------------------- API
const api = express.Router();
api.use(express.json({ limit: '4kb' }));

function badRequest(res, message) {
  return res.status(400).json({ error: 'bad_request', message });
}

// วันที่ที่จองได้คือวันนี้ถึงอีก 13 วันข้างหน้า ตามเวลาไทย
function bookableRange() {
  const today = bangkokNow().date;
  return { from: today, to: addDays(today, BOOKING_WINDOW_DAYS - 1) };
}

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

api.get('/', (req, res) => {
  res.json({
    service: SERVICE,
    version: VERSION,
    endpoints: [
      'GET    /api/rooms',
      'GET    /api/rooms/:id/slots?date=YYYY-MM-DD',
      'POST   /api/bookings',
      'DELETE /api/bookings/:id',
    ],
  });
});

api.get('/rooms', async (req, res) => {
  const range = bookableRange();
  res.json({
    rooms: await store.listRooms(),
    open_hour: OPEN_HOUR,
    close_hour: CLOSE_HOUR,
    bookable_from: range.from,
    bookable_to: range.to,
  });
});

// journey หลัก: ดูว่าห้องหนึ่งว่างชั่วโมงไหนในวันหนึ่ง
api.get('/rooms/:id/slots', async (req, res) => {
  const roomId = parseId(req.params.id);
  if (!roomId) return badRequest(res, 'รหัสห้องต้องเป็นจำนวนเต็มบวก');

  const date = req.query.date || bangkokNow().date;
  if (!isValidDate(date)) return badRequest(res, 'วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD');

  const room = await store.getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'not_found', message: 'ไม่พบห้องนี้' });

  res.json({ room, date, slots: await store.getSlots(roomId, date) });
});

api.post('/bookings', async (req, res) => {
  const body = req.body || {};
  const roomId = parseId(body.room_id);
  const startHour = Number(body.start_hour);
  const bookedBy = typeof body.booked_by === 'string' ? body.booked_by.trim() : '';
  const { date } = body;

  if (!roomId) return badRequest(res, 'ต้องระบุ room_id');
  if (!isValidDate(date)) return badRequest(res, 'วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD');
  if (!Number.isInteger(startHour) || startHour < OPEN_HOUR || startHour >= CLOSE_HOUR) {
    return badRequest(res, `start_hour ต้องอยู่ระหว่าง ${OPEN_HOUR} ถึง ${CLOSE_HOUR - 1}`);
  }
  if (!bookedBy || bookedBy.length > NAME_MAX) {
    return badRequest(res, `ต้องใส่ชื่อผู้จอง ยาวไม่เกิน ${NAME_MAX} ตัวอักษร`);
  }

  const range = bookableRange();
  if (date < range.from || date > range.to) {
    return badRequest(res, `จองได้ตั้งแต่ ${range.from} ถึง ${range.to}`);
  }
  const now = bangkokNow();
  if (date === now.date && startHour <= now.hour) {
    return badRequest(res, 'ช่วงเวลานี้เริ่มไปแล้ว');
  }

  if (!(await store.getRoom(roomId))) {
    return res.status(404).json({ error: 'not_found', message: 'ไม่พบห้องนี้' });
  }

  const booking = await store.createBooking({ roomId, date, startHour, bookedBy });
  res.status(201).json({ booking });
});

api.delete('/bookings/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, 'รหัสการจองต้องเป็นจำนวนเต็มบวก');
  await store.cancelBooking(id);
  res.status(204).end();
});

api.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

app.use('/api', api);

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// ข้อผิดพลาดที่ store โยนมา แปลงเป็นรหัส HTTP ที่ถูกต้อง
// อะไรที่ไม่รู้จักเป็น 500 ซึ่ง SLI นับเป็นคำขอที่ล้มเหลว
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'conflict') return res.status(409).json({ error: 'conflict', message: err.message });
  if (err.code === 'not_found') return res.status(404).json({ error: 'not_found', message: err.message });
  if (err.type === 'entity.parse.failed') return badRequest(res, 'เนื้อหาคำขอต้องเป็น JSON');
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'bad_request' });

  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: 'internal', message: 'ระบบขัดข้อง' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`${SERVICE} ${VERSION} listening on http://${HOST}:${PORT}`);
});

// docker compose stop ส่ง SIGTERM ให้ปิดรับคำขอใหม่ แล้วรอคำขอที่ค้างอยู่ให้เสร็จ
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
