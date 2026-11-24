# roombook

ระบบจองห้องติวในหอสมุด ใช้เป็นบริการที่ถูกวัด SLO ในแล็บ INT531
ทดสอบสถานการณ์ปัญหา นักศึกษาเปิดดูว่าห้องไหนว่างชั่วโมงไหน แล้วจองครั้งละ 1 ชั่วโมง

## โครงสร้าง

```
roombook/
├── frontend/      nginx ส่งหน้าเว็บ และส่งต่อ /api/ ไปที่ backend
├── backend/       Express ตอบ API
├── db/            init.sql สร้างตารางและห้องตั้งต้น
├── compose.yaml
└── .env.example
```

```
เบราว์เซอร์ ──> frontend (nginx :80) ──/api/──> backend (Express :8080) ──> db (PostgreSQL :5432)
```

| service | image | พอร์ตบน VM | ใครเข้าได้ |
|---|---|---|---|
| frontend | build จาก `frontend/` | 80 | ทุกเครื่องที่เห็น VM |
| backend | build จาก `backend/` | 127.0.0.1:8080 | เฉพาะตัว VM เครื่องมือแล็บใช้พอร์ตนี้ |
| db | `postgres:16-alpine` | ไม่เปิด | เฉพาะ backend ผ่านเครือข่ายภายในของ Docker |

## รันบน VM ด้วย Docker

```bash
git clone https://github.com/SvechaZ/LabChaos.git
cd LabChaos
cp .env.example .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 16)|" .env
docker compose up -d --build
docker compose ps        # ทั้งสาม service ต้องขึ้น healthy
```

เปิด `http://<IP ของ VM>/` ถ้าพอร์ต 80 มีโปรแกรมอื่นใช้อยู่ ให้แก้ `WEB_PORT` ใน `.env`

ข้อมูลการจองอยู่ใน volume `db-data` ปิดแล้วเปิดใหม่ด้วย `docker compose down` และ
`up -d` ข้อมูลยังอยู่ ถ้าใช้ `docker compose down -v` ข้อมูลทั้งหมดจะหาย

`db/init.sql` รันครั้งเดียวตอน volume ยังว่าง แก้ไฟล์นี้แล้วต้อง `down -v` ก่อนจึงจะมีผล

## เมื่อฐานข้อมูลมีปัญหา

backend ไม่รอฐานข้อมูลนานเกินหน้าเว็บ ซึ่งตัดคำขอที่ 8 วินาที

| อาการของฐานข้อมูล | backend ตอบ | ภายใน |
|---|---|---|
| ปิดอยู่ ต่อไม่ติด | 502 | ทันที |
| ค้าง รับ connection แต่ไม่ตอบ | 502 | 2 ถึง 4 วินาที |
| กลับมาปกติ | 200 | ทันที ไม่ต้องรีสตาร์ต backend |

`/healthz` ของ backend ไม่ถามฐานข้อมูล docker จึงไม่รีสตาร์ต backend ตอนฐานข้อมูลล่ม
ใช้ `/readyz` ถ้าอยากรู้ว่า backend คุยกับฐานข้อมูลได้หรือไม่

ลองให้ฐานข้อมูลล่มจริงได้ด้วย

```bash
docker compose stop db      # หน้าเว็บยังเปิดได้ แต่โหลดตารางได้ 502
docker compose start db
```

## รันบนเครื่องตัวเองโดยไม่มี Docker

ต้องมี Node 20 ขึ้นไป โหมดนี้เก็บการจองในหน่วยความจำ ไม่ต้องมีฐานข้อมูล

```bash
cd frontend && npm ci && cd ..     # ดึงไฟล์ฟอนต์
cd backend && npm ci
PORT=18080 npm run dev
```

เปิด `http://localhost:18080/` โหมดนี้ backend ส่งหน้าเว็บจาก `frontend/public` เอง
ใช้ตอนแก้หน้าเว็บเท่านั้น ใน Docker หน้าเว็บมาจาก nginx

## API

| คำขอ | ทำอะไร |
|---|---|
| `GET /api/rooms` | รายชื่อห้อง เวลาเปิดปิด และช่วงวันที่จองได้ |
| `GET /api/rooms/:id/slots?date=YYYY-MM-DD` | ช่องว่างรายชั่วโมงของห้องในวันนั้น เป็น user journey หลักที่วัด SLO |
| `POST /api/bookings` | จอง ส่ง `room_id`, `date`, `start_hour`, `booked_by` |
| `DELETE /api/bookings/:id` | ยกเลิกการจอง |
| `GET /healthz` | backend ยังรันอยู่ |
| `GET /readyz` | backend คุยกับฐานข้อมูลได้ |
| `GET /version` | เวอร์ชันที่รันอยู่ |
| `GET /metrics` | เมตริกให้ Prometheus และ `slo_watch.py` อ่าน |

รหัสตอบกลับ: 400 ข้อมูลผิด, 404 ไม่พบห้องหรือการจอง, 409 มีคนจองช่องนี้แล้ว,
502 ติดต่อฐานข้อมูลไม่ได้

## เมตริก

backend นับเฉพาะคำขอ `/api/...` ไม่นับ `/metrics`, `/healthz` และไฟล์หน้าเว็บ

| เมตริก | ชนิด | ป้ายกำกับ |
|---|---|---|
| `http_requests_total` | counter | `service`, `path`, `code` |
| `http_request_duration_seconds` | histogram | `service`, `path`, `le` |
| `app_build_info` | gauge | `service`, `version` |
| `app_dependency_up` | gauge | 1 คือฐานข้อมูลตอบได้ เช็กทุก 5 วินาที |
| `app_inflight_requests` | gauge | คำขอที่กำลังทำอยู่ |

- `path` เป็นแบบของ route เช่น `/api/rooms/:id/slots` คำขอที่ไม่ตรง route ใดรวมเป็น `unmatched`
- bucket ของ histogram เป็นชุดเดียวกับบริการเดโมของแล็บ รวม `le="1.0"` ที่กฎ latency ใช้
- ผู้ใช้ตัดการเชื่อมต่อก่อนได้คำตอบ นับเป็น `code="0"` กฎของแล็บถือว่าล้มเหลว

ดูค่า SLO ของ journey หลักด้วยเครื่องมือของแล็บ รันบน VM

```bash
python3 app/slo_watch.py --path "/api/rooms/:id/slots"
```
