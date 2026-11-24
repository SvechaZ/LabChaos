'use strict';

// เมตริกในรูปแบบข้อความของ Prometheus ตามหัวข้อ 8.2 ของใบงาน
//
// เขียนเองแทนการใช้ prom-client เพราะกฎใน monitoring/rules/ ของแล็บค้นหา le="1.0"
// ตรงตัวอักษร แต่ prom-client เขียนเป็น le="1" ที่นี่จึงเขียน bucket ให้ตรงกับ demo_service.py
//
// นับเฉพาะคำขอ /api/... ซึ่งเป็น journey ของผู้ใช้ ไม่นับ /metrics /healthz และไฟล์หน้าเว็บ

const SERVICE = 'roombook';

// ชุดเดียวกับ demo_service.py ทำให้ slo_watch.py --threshold ใช้ค่าเดิมได้
const BUCKETS = ['0.05', '0.1', '0.25', '0.5', '1.0', '2.0', '5.0', '10.0'];
const EDGES = BUCKETS.map(Number);

const counts = new Map();     // "path|code" -> n
const histograms = new Map(); // path -> { buckets: [...], sum, count }
let inflight = 0;
let dependencyUp = 1;
let buildVersion = '0.0.0';

function observe(path, code, seconds) {
  const key = `${path}|${code}`;
  counts.set(key, (counts.get(key) || 0) + 1);

  let h = histograms.get(path);
  if (!h) {
    h = { buckets: new Array(EDGES.length).fill(0), sum: 0, count: 0 };
    histograms.set(path, h);
  }
  const i = EDGES.findIndex((edge) => seconds <= edge);
  if (i >= 0) h.buckets[i] += 1;
  h.sum += seconds;
  h.count += 1;
}

// ป้าย path ใช้แบบของ route เช่น /api/rooms/:id/slots ไม่ใช่ URL จริงที่มีเลขห้อง
// คำขอที่ไม่ตรง route ใดเลยรวมเป็น unmatched จำนวน series จึงไม่โตตามสิ่งที่คนพิมพ์มา
// เก็บ baseUrl ไว้ตอนคำขอเข้ามา เพราะ Express คืนค่า baseUrl เดิมตอนคำขอออกจาก router
// ซึ่งอาจเกิดก่อน event finish
function routeOf(req, base) {
  return req.route ? `${base}${req.route.path}` : 'unmatched';
}

function middleware(req, res, next) {
  const t0 = process.hrtime.bigint();
  const base = req.baseUrl;
  inflight += 1;
  let done = false;

  const finish = (code) => {
    if (done) return;
    done = true;
    inflight -= 1;
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    observe(routeOf(req, base), code, seconds);
  };

  res.on('finish', () => finish(String(res.statusCode)));
  // ผู้ใช้หรือ nginx ตัดการเชื่อมต่อก่อนได้คำตอบ เช่นหน้าเว็บรอครบ 8 วินาที
  // นับเป็น code="0" ซึ่งกฎของแล็บถือว่าล้มเหลว เพราะผู้ใช้ไม่ได้อะไรกลับไป
  res.on('close', () => finish('0'));
  next();
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function render() {
  const out = [];
  const add = (s) => out.push(s);

  add('# HELP app_build_info เวอร์ชันของบริการที่กำลังรันอยู่');
  add('# TYPE app_build_info gauge');
  add(`app_build_info{service="${SERVICE}",version="${esc(buildVersion)}"} 1`);

  add('# HELP http_requests_total จำนวนคำขอ API แยกตามเส้นทางและรหัสตอบกลับ');
  add('# TYPE http_requests_total counter');
  for (const [key, n] of [...counts].sort()) {
    const [path, code] = key.split('|');
    add(`http_requests_total{service="${SERVICE}",path="${esc(path)}",code="${code}"} ${n}`);
  }

  add('# HELP http_request_duration_seconds เวลาที่ใช้ตอบคำขอ API');
  add('# TYPE http_request_duration_seconds histogram');
  for (const [path, h] of [...histograms].sort()) {
    const p = esc(path);
    let cum = 0;
    BUCKETS.forEach((le, i) => {
      cum += h.buckets[i];
      add(`http_request_duration_seconds_bucket{service="${SERVICE}",path="${p}",le="${le}"} ${cum}`);
    });
    add(`http_request_duration_seconds_bucket{service="${SERVICE}",path="${p}",le="+Inf"} ${h.count}`);
    add(`http_request_duration_seconds_sum{service="${SERVICE}",path="${p}"} ${h.sum.toFixed(6)}`);
    add(`http_request_duration_seconds_count{service="${SERVICE}",path="${p}"} ${h.count}`);
  }

  add('# HELP app_inflight_requests คำขอ API ที่กำลังประมวลผลอยู่');
  add('# TYPE app_inflight_requests gauge');
  add(`app_inflight_requests ${inflight}`);

  add('# HELP app_dependency_up ฐานข้อมูลตอบได้หรือไม่ 1 คือปกติ');
  add('# TYPE app_dependency_up gauge');
  add(`app_dependency_up ${dependencyUp}`);

  return `${out.join('\n')}\n`;
}

module.exports = {
  middleware,
  render,
  setVersion: (v) => { buildVersion = v; },
  setDependencyUp: (up) => { dependencyUp = up ? 1 : 0; },
};
