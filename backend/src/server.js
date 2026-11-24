'use strict';

// roombook backend: API ของระบบจองห้องติว
//   /api/...     API ที่หน้าเว็บเรียก และเป็น user journey ที่วัด SLO
//   /healthz     backend ยังรันอยู่ ไม่ถามฐานข้อมูล docker ใช้ตัวนี้
//   /readyz      backend คุยกับฐานข้อมูลได้
//   /version     เวอร์ชันที่รันอยู่
//
// หน้าเว็บอยู่ใน frontend/ และ nginx เป็นตัวส่ง ไม่ใช่ service นี้
// ข้อมูลอยู่ใน PostgreSQL (STORE=postgres) หรือในหน่วยความจำตอนพัฒนา (STORE=memory)

const path = require('path');
const express = require('express');
const { version: VERSION } = require('../package.json');
const {
  OPEN_HOUR, CLOSE_HOUR, BOOKING_WINDOW_DAYS, CONTROL_CHARS,
  bangkokNow, addDays, isValidDate, parseRoomId, parseBookingId,
} = require('./store/common');
const STORE = process.env.STORE || 'memory';
if (!['memory', 'postgres'].includes(STORE)) {
  console.error(`STORE ต้องเป็น memory หรือ postgres ได้ ${STORE}`);
  process.exit(1);
}
const store = require(`./store/${STORE}`);
const metrics = require('./metrics');

metrics.setVersion(VERSION);

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

// ---------------------------------------------------------------- โหมดพัฒนา
// npm run dev ตั้ง DEV_STATIC=../frontend ให้ส่งหน้าเว็บเองได้บนเครื่องที่ไม่มี Docker
// ใน container ไม่ตั้งค่านี้ หน้าเว็บจึงมาจาก nginx เท่านั้น
if (process.env.DEV_STATIC) {
  const dir = path.resolve(__dirname, '..', process.env.DEV_STATIC);
  app.use(express.static(path.join(dir, 'public')));
  app.use('/fonts', express.static(path.join(dir, 'node_modules', '@fontsource')));
  console.log(`dev mode: serving web page from ${dir}`);
}

// ---------------------------------------------------------------- ระบบ
// ไม่ถามฐานข้อมูล ถ้าฐานข้อมูลล่ม docker จะได้ไม่เข้าใจผิดว่า backend เสีย
app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: VERSION });
});

app.get('/readyz', async (req, res) => {
  try {
    await store.ping();
    res.json({ ok: true, store: STORE });
  } catch (err) {
    res.status(503).json({ ok: false, store: STORE, message: err.message });
  }
});

// Prometheus และ slo_watch.py ของแล็บอ่านที่นี่
app.get('/metrics', (req, res) => {
  res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
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
// วางก่อน express.json คำขอที่ส่ง JSON เสียมาจะได้ถูกนับด้วย
api.use(metrics.middleware);
api.use(express.json({ limit: '4kb' }));

function badRequest(res, message) {
  return res.status(400).json({ error: 'bad_request', message });
}

// วันที่ที่จองได้คือวันนี้ถึงอีก 13 วันข้างหน้า ตามเวลาไทย
function bookableRange() {
  const today = bangkokNow().date;
  return { from: today, to: addDays(today, BOOKING_WINDOW_DAYS - 1) };
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
  const roomId = parseRoomId(req.params.id);
  if (!roomId) return badRequest(res, 'รหัสห้องต้องเป็นจำนวนเต็มบวก');

  const date = req.query.date || bangkokNow().date;
  if (!isValidDate(date)) return badRequest(res, 'วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD');

  const room = await store.getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'not_found', message: 'ไม่พบห้องนี้' });

  res.json({ room, date, slots: await store.getSlots(roomId, date) });
});

api.post('/bookings', async (req, res) => {
  const body = req.body || {};
  const roomId = parseRoomId(body.room_id);
  const startHour = Number(body.start_hour);
  const bookedBy = typeof body.booked_by === 'string' ? body.booked_by.trim() : '';
  const { date } = body;

  if (!roomId) return badRequest(res, 'room_id ต้องเป็นจำนวนเต็มบวก');
  if (!isValidDate(date)) return badRequest(res, 'วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD');
  if (!Number.isInteger(startHour) || startHour < OPEN_HOUR || startHour >= CLOSE_HOUR) {
    return badRequest(res, `start_hour ต้องอยู่ระหว่าง ${OPEN_HOUR} ถึง ${CLOSE_HOUR - 1}`);
  }
  if (!bookedBy || bookedBy.length > NAME_MAX) {
    return badRequest(res, `ต้องใส่ชื่อผู้จอง ยาวไม่เกิน ${NAME_MAX} ตัวอักษร`);
  }
  if (CONTROL_CHARS.test(bookedBy)) {
    return badRequest(res, 'ชื่อผู้จองมีอักขระที่ใช้ไม่ได้');
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
  const id = parseBookingId(req.params.id);
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
  if (err.code === 'bad_input') return badRequest(res, err.message);
  // ชั้นล่างล้มเหลว ไม่ใช่โค้ดเราผิด ตอบ 502 แบบเดียวกับบริการเดโมของแล็บ
  // SLI ยังนับเป็นคำขอที่ล้มเหลว (ดูคำถามเรื่องนับ 502 ในสถานการณ์ 03)
  if (err.code === 'unavailable') {
    metrics.setDependencyUp(false);
    console.error(`${req.method} ${req.originalUrl} database unavailable: ${err.message}`);
    return res.status(502).json({ error: 'dependency_failed', message: err.message });
  }
  if (err.type === 'entity.parse.failed') return badRequest(res, 'เนื้อหาคำขอต้องเป็น JSON');
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'bad_request' });

  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: 'internal', message: 'ระบบขัดข้อง' });
});

// เช็กฐานข้อมูลทุก 5 วินาที app_dependency_up จะถูกต้องแม้ไม่มีใครเปิดเว็บ
async function checkDependency() {
  try {
    await store.ping();
    metrics.setDependencyUp(true);
  } catch {
    metrics.setDependencyUp(false);
  }
}
checkDependency();
const depTimer = setInterval(checkDependency, 5000);
depTimer.unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`${SERVICE} ${VERSION} listening on http://${HOST}:${PORT} store=${STORE}`);
});

// docker compose stop ส่ง SIGTERM ให้ปิดรับคำขอใหม่ รอคำขอที่ค้างให้เสร็จ แล้วปิด connection ฐานข้อมูล
function shutdown() {
  server.close(async () => {
    await store.close().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
