'use strict';

// roombook หน้าเว็บ
// โหลดรายชื่อห้องครั้งเดียว แล้วโหลดช่องเวลาของแต่ละห้องแยกกัน
// ถ้าห้องไหนโหลดไม่ได้ แถวนั้นจะขึ้นรหัสข้อผิดพลาด ส่วนแถวอื่นยังใช้ได้

(() => {
  const TZ = 'Asia/Bangkok';
  const TIMEOUT_MS = 8000;
  const MINE_KEY = 'roombook.mine';
  const NAME_KEY = 'roombook.name';

  const $ = (id) => document.getElementById(id);
  const el = {
    weekday: $('weekday'), day: $('day-number'), month: $('month-year'),
    input: $('date-input'), prev: $('prev-day'), next: $('next-day'), today: $('today'),
    board: $('board'), caption: $('grid-caption'), head: $('grid-head'), body: $('grid-body'),
    grid: $('grid'), status: $('status'),
    notice: $('notice'), noticeText: $('notice-text'), noticeRetry: $('notice-retry'),
    wireCall: $('wire-call'), wireCode: $('wire-code'), wireMs: $('wire-ms'), wireVersion: $('wire-version'),
    sheet: $('sheet'), sheetForm: $('sheet-form'), sheetTitle: $('sheet-title'), sheetWhen: $('sheet-when'),
    sheetError: $('sheet-error'), sheetSubmit: $('sheet-submit'), sheetCancel: $('sheet-cancel'),
    name: $('booked-by'),
    release: $('release'), releaseForm: $('release-form'), releaseTitle: $('release-title'),
    releaseWhen: $('release-when'), releaseError: $('release-error'),
    releaseSubmit: $('release-submit'), releaseKeep: $('release-keep'),
  };

  const state = {
    meta: null,        // คำตอบจาก /api/rooms
    date: null,        // YYYY-MM-DD ที่กำลังดู
    rows: new Map(),   // roomId -> { slots } หรือ { error }
    pick: null,        // ช่องที่กำลังจองหรือยกเลิก
    loadSeq: 0,        // กันคำตอบของวันเก่ามาทับวันใหม่
  };

  // ---------------------------------------------------------------- เวลา

  function bangkokHour() {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' })
      .format(new Date()));
  }

  function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  const span = (h) => `${hh(h)} ถึง ${hh(h + 1)}`;

  function thaiDateParts(iso) {
    const d = new Date(`${iso}T12:00:00+07:00`);
    const f = (opts) => new Intl.DateTimeFormat('th-TH', { timeZone: TZ, ...opts }).format(d);
    return {
      weekday: f({ weekday: 'long' }),
      day: String(Number(iso.slice(8, 10))),
      monthYear: f({ month: 'long', year: 'numeric' }),
      long: f({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      short: f({ day: 'numeric', month: 'short' }),
    };
  }

  // ---------------------------------------------------------------- จำในเบราว์เซอร์

  // จำการจองของเราด้วยรหัสคู่กับห้อง วัน ชั่วโมง และชื่อ ไม่ใช่รหัสอย่างเดียว
  // รหัสเริ่มนับใหม่เมื่อล้างฐานข้อมูล ถ้าจำแค่รหัส จะเห็นการจองของคนอื่นเป็นของเรา
  const mineKey = (id, roomId, date, hour, name) => `${id}|${roomId}|${date}|${hour}|${name}`;

  function readMine() {
    try {
      const list = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
      return new Set(list.filter((x) => typeof x === 'string'));
    } catch { return new Set(); }
  }
  function writeMine(set) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify([...set].slice(-200))); } catch { /* โหมดส่วนตัว */ }
  }
  const mine = readMine();

  // ---------------------------------------------------------------- เรียก API

  // ทุกคำขอผ่านที่นี่ เพื่อให้แถบท้ายหน้าแสดงรหัสและเวลาที่ใช้จริง
  async function request(method, url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    let status = 0;
    let data = null;
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      status = res.status;
      const version = res.headers.get('X-App-Version');
      if (version) el.wireVersion.textContent = `roombook ${version}`;
      if (status !== 204) data = await res.json().catch(() => null);
    } catch (err) {
      status = 0;
      data = { message: err.name === 'AbortError' ? `ไม่ตอบภายใน ${TIMEOUT_MS / 1000} วินาที` : 'ติดต่อเซิร์ฟเวอร์ไม่ได้' };
    } finally {
      clearTimeout(timer);
    }
    showWire(method, url, status, performance.now() - t0);
    return { ok: status >= 200 && status < 300, status, data };
  }

  function showWire(method, url, status, ms) {
    el.wireCall.textContent = `${method} ${url.replace(/\?.*$/, '')}`;
    el.wireCode.textContent = status ? String(status) : 'หมดเวลา';
    el.wireCode.className = 'wire__code mono ' + (
      status >= 200 && status < 400 ? 'wire__code--ok'
        : status >= 400 && status < 500 ? 'wire__code--warn'
          : 'wire__code--bad');
    el.wireMs.textContent = `${Math.round(ms)} ms`;
  }

  function describeFailure(r) {
    if (r.status === 0) return r.data.message;
    const msg = r.data && r.data.message ? ` ${r.data.message}` : '';
    return `ระบบตอบ ${r.status}${msg}`;
  }

  // ---------------------------------------------------------------- ประกาศและแจ้งปัญหา

  // ล้างก่อนแล้วค่อยใส่ข้อความ screen reader จึงอ่านซ้ำได้แม้ข้อความเหมือนรอบก่อน
  function announce(text) {
    el.status.textContent = '';
    setTimeout(() => { el.status.textContent = text; }, 50);
  }

  function showNotice(text) {
    el.noticeText.textContent = text;
    el.notice.hidden = false;
  }
  function hideNotice() { el.notice.hidden = true; }

  // ---------------------------------------------------------------- แสดงผล

  function renderHeader() {
    const p = thaiDateParts(state.date);
    const isToday = state.date === state.meta.bookable_from;
    el.weekday.textContent = isToday ? `${p.weekday} วันนี้` : p.weekday;
    el.day.textContent = p.day;
    el.month.textContent = p.monthYear;
    el.caption.textContent = `ห้องว่างรายชั่วโมง ${p.long}`;
    el.input.value = state.date;
    el.input.min = state.meta.bookable_from;
    el.input.max = state.meta.bookable_to;
    el.prev.disabled = state.date <= state.meta.bookable_from;
    el.next.disabled = state.date >= state.meta.bookable_to;
    el.today.hidden = isToday;
    document.title = `${p.short} roombook จองห้องติว`;
  }

  const keyOf = (roomId, hour) => `${roomId}-${hour}`;

  function makeCell(room, slot, opts) {
    const td = document.createElement('td');
    const when = `${room.code} เวลา ${span(slot.start_hour)}`;

    const key = slot.booked ? mineKey(slot.booking_id, room.id, state.date, slot.start_hour, slot.booked_by) : null;
    if (slot.booked && mine.has(key)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot slot--mine' + (opts.fresh === slot.booking_id ? ' slot--fresh' : '');
      btn.title = slot.booked_by; // ชื่อยาวถูกตัดด้วย ... ชี้เมาส์เพื่อดูชื่อเต็ม
      btn.dataset.key = keyOf(room.id, slot.start_hour);
      // ชื่อที่เห็นบนปุ่มอยู่ต้นชื่อที่ screen reader อ่าน ตามเกณฑ์ 2.5.3
      btn.setAttribute('aria-label', `${slot.booked_by} การจองของคุณ ${when} กดเพื่อยกเลิก`);
      const name = document.createElement('span');
      name.className = 'slot__name';
      name.textContent = slot.booked_by;
      btn.append(name);
      btn.addEventListener('click', () => openRelease(room, slot));
      td.append(btn);
      return td;
    }

    if (slot.booked) {
      const box = document.createElement('div');
      box.className = 'slot slot--taken';
      box.title = slot.booked_by;
      const hidden = document.createElement('span');
      hidden.className = 'sr-only';
      hidden.textContent = 'จองแล้วโดย ';
      const name = document.createElement('span');
      name.className = 'slot__name';
      name.textContent = slot.booked_by;
      box.append(hidden, name);
      td.append(box);
      return td;
    }

    if (opts.past) {
      td.className = 'is-past';
      const hidden = document.createElement('span');
      hidden.className = 'sr-only';
      hidden.textContent = 'เลยเวลาแล้ว';
      td.append(hidden);
      return td;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot slot--free';
    btn.dataset.key = keyOf(room.id, slot.start_hour);
    btn.textContent = 'จอง';
    btn.setAttribute('aria-label', `จอง ${when}`);
    btn.addEventListener('click', () => openSheet(room, slot));
    td.append(btn);
    return td;
  }

  function renderHead() {
    const { open_hour: open, close_hour: close } = state.meta;
    const tr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.textContent = 'ห้อง';
    tr.append(corner);
    for (let h = open; h < close; h++) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = hh(h);
      tr.append(th);
    }
    el.head.replaceChildren(tr);
  }

  function renderBody({ fresh, focusKey } = {}) {
    const { rooms, open_hour: open, close_hour: close } = state.meta;
    const isToday = state.date === state.meta.bookable_from;
    const nowHour = bangkokHour();
    const frag = document.createDocumentFragment();

    for (const room of rooms) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      const code = document.createElement('span');
      code.className = 'room__code';
      code.textContent = room.code;
      const meta = document.createElement('span');
      meta.className = 'room__meta';
      meta.textContent = `${room.capacity} ที่นั่ง`;
      th.append(code, meta);
      tr.append(th);

      const row = state.rows.get(room.id);
      if (!row || row.error) {
        const td = document.createElement('td');
        td.colSpan = close - open;
        td.className = 'grid__message' + (row ? ' grid__message--bad' : '');
        td.textContent = row ? `โหลดห้องนี้ไม่ได้ ${row.text}` : 'กำลังโหลด';
        tr.append(td);
      } else {
        for (const slot of row.slots) {
          tr.append(makeCell(room, slot, { past: isToday && slot.start_hour <= nowHour, fresh }));
        }
      }
      frag.append(tr);
    }

    el.body.replaceChildren(frag);

    // ปุ่มเดิมถูกสร้างใหม่ ย้ายโฟกัสกลับมาที่ช่องเดิม ไม่ปล่อยให้หลุดไปต้นหน้า (2.4.3)
    if (focusKey) {
      const target = el.body.querySelector(`[data-key="${focusKey}"]`);
      if (target) target.focus();
      else el.board.focus();
    }
  }

  // ---------------------------------------------------------------- โหลดข้อมูล

  async function loadMeta() {
    const r = await request('GET', '/api/rooms');
    if (!r.ok) {
      showNotice(`โหลดรายชื่อห้องไม่ได้ ${describeFailure(r)}`);
      el.board.setAttribute('aria-busy', 'false');
      return false;
    }
    state.meta = r.data;
    if (!state.date || state.date < r.data.bookable_from || state.date > r.data.bookable_to) {
      // หลังช่องสุดท้ายของวันเริ่มแล้ว วันนี้ไม่เหลืออะไรให้จอง เปิดพรุ่งนี้แทน
      const dayOver = bangkokHour() >= r.data.close_hour - 1;
      state.date = dayOver ? addDays(r.data.bookable_from, 1) : r.data.bookable_from;
    }
    renderHead();
    return true;
  }

  async function loadRow(roomId, date) {
    const r = await request('GET', `/api/rooms/${roomId}/slots?date=${date}`);
    return r.ok ? { slots: r.data.slots } : { error: r.status || 'หมดเวลา', text: describeFailure(r) };
  }

  async function loadDay({ announceDate = false } = {}) {
    if (!state.meta && !(await loadMeta())) return;
    const seq = ++state.loadSeq;
    const date = state.date;
    hideNotice();
    renderHeader();
    el.board.setAttribute('aria-busy', 'true');

    const results = await Promise.all(state.meta.rooms.map((room) => loadRow(room.id, date)));
    if (seq !== state.loadSeq) return; // ผู้ใช้เปลี่ยนวันไปแล้ว

    state.rows = new Map(state.meta.rooms.map((room, i) => [room.id, results[i]]));
    const failed = results.filter((x) => x.error);
    if (failed.length) {
      showNotice(failed.length === results.length
        ? `โหลดตารางไม่ได้ ${failed[0].text}`
        : `โหลดได้บางห้อง ${failed.length} จาก ${results.length} ห้องมีปัญหา ${failed[0].text}`);
    }
    renderBody();
    el.board.setAttribute('aria-busy', 'false');
    if (announceDate) announce(`แสดงตาราง${thaiDateParts(date).long}`);
  }

  async function reloadRoom(roomId, opts) {
    state.rows.set(roomId, await loadRow(roomId, state.date));
    renderBody(opts);
  }

  // ใส่วันที่ไว้ใน URL เช่น /?date=2026-11-25 ส่งลิงก์ให้เพื่อนแล้วเปิดวันเดียวกันได้
  function goTo(date) {
    state.date = date;
    const url = date === state.meta.bookable_from ? location.pathname : `?date=${date}`;
    history.replaceState(null, '', url);
    loadDay({ announceDate: true });
  }

  // ---------------------------------------------------------------- จอง

  function setNameError(text) {
    if (text) {
      el.sheetError.textContent = text;
      el.sheetError.hidden = false;
      el.name.setAttribute('aria-invalid', 'true');
      el.name.setAttribute('aria-describedby', 'sheet-error booked-by-hint');
    } else {
      el.sheetError.hidden = true;
      el.name.removeAttribute('aria-invalid');
      el.name.setAttribute('aria-describedby', 'booked-by-hint');
    }
  }

  function showSheetError(text) {
    el.sheetError.textContent = text;
    el.sheetError.hidden = false;
    el.sheetError.setAttribute('role', 'alert');
  }

  function openSheet(room, slot) {
    state.pick = { room, slot };
    el.sheetTitle.textContent = `จองห้อง ${room.code}`;
    el.sheetWhen.textContent = `${thaiDateParts(state.date).long} เวลา ${span(slot.start_hour)} ห้องนี้นั่งได้ ${room.capacity} คน`;
    setNameError(null);
    el.sheetError.removeAttribute('role');
    el.sheetSubmit.disabled = false;
    el.name.value = localStorage.getItem(NAME_KEY) || '';
    el.sheet.showModal();
    el.name.focus();
    el.name.select();
  }

  async function submitBooking(ev) {
    ev.preventDefault();
    const name = el.name.value.trim();
    if (!name) {
      setNameError('ใส่ชื่อผู้จองก่อน');
      el.sheetError.setAttribute('role', 'alert');
      el.name.focus();
      return;
    }
    setNameError(null);
    const { room, slot } = state.pick;
    const key = keyOf(room.id, slot.start_hour);
    el.sheetSubmit.disabled = true;

    const r = await request('POST', '/api/bookings', {
      room_id: room.id, date: state.date, start_hour: slot.start_hour, booked_by: name,
    });

    if (r.ok) {
      try { localStorage.setItem(NAME_KEY, name); } catch { /* โหมดส่วนตัว */ }
      const b = r.data.booking;
      mine.add(mineKey(b.id, b.room_id, b.date, b.start_hour, b.booked_by));
      writeMine(mine);
      el.sheet.close();
      await reloadRoom(room.id, { fresh: r.data.booking.id, focusKey: key });
      announce(`จองห้อง ${room.code} เวลา ${span(slot.start_hour)} ในชื่อ ${name} แล้ว`);
      return;
    }

    el.sheetSubmit.disabled = false;
    if (r.status === 409) {
      showSheetError('มีคนจองช่วงนี้ไปก่อนแล้ว ตารางอัปเดตให้แล้ว ลองเลือกช่องอื่น');
      reloadRoom(room.id);
    } else if (r.status >= 400 && r.status < 500) {
      showSheetError(r.data && r.data.message ? r.data.message : `ระบบไม่รับคำขอ (${r.status})`);
    } else {
      showSheetError(`${describeFailure(r)} ยังไม่ได้จอง กดยืนยันอีกครั้งได้`);
    }
  }

  // ---------------------------------------------------------------- ยกเลิก

  function openRelease(room, slot) {
    state.pick = { room, slot };
    el.releaseTitle.textContent = `ยกเลิกห้อง ${room.code}`;
    el.releaseWhen.textContent = `${thaiDateParts(state.date).long} เวลา ${span(slot.start_hour)} ในชื่อ ${slot.booked_by}`;
    el.releaseError.hidden = true;
    el.releaseSubmit.disabled = false;
    el.release.showModal();
    el.releaseKeep.focus(); // ปุ่มที่ไม่ทำลายข้อมูลได้โฟกัสก่อน
  }

  async function submitRelease(ev) {
    ev.preventDefault();
    const { room, slot } = state.pick;
    const key = keyOf(room.id, slot.start_hour);
    el.releaseSubmit.disabled = true;
    const r = await request('DELETE', `/api/bookings/${slot.booking_id}`);
    if (r.ok || r.status === 404) {
      mine.delete(mineKey(slot.booking_id, room.id, state.date, slot.start_hour, slot.booked_by));
      writeMine(mine);
      el.release.close();
      await reloadRoom(room.id, { focusKey: key });
      announce(`ยกเลิกการจองห้อง ${room.code} เวลา ${span(slot.start_hour)} แล้ว`);
      return;
    }
    el.releaseSubmit.disabled = false;
    el.releaseError.textContent = `${describeFailure(r)} การจองยังอยู่ ลองอีกครั้งได้`;
    el.releaseError.hidden = false;
  }

  // ---------------------------------------------------------------- ผูกปุ่ม

  el.prev.addEventListener('click', () => goTo(addDays(state.date, -1)));
  el.next.addEventListener('click', () => goTo(addDays(state.date, 1)));
  el.today.addEventListener('click', () => goTo(state.meta.bookable_from));
  el.input.addEventListener('change', () => {
    const v = el.input.value;
    if (v && v >= state.meta.bookable_from && v <= state.meta.bookable_to) goTo(v);
    else el.input.value = state.date;
  });
  el.noticeRetry.addEventListener('click', () => loadDay());

  el.sheetForm.addEventListener('submit', submitBooking);
  el.sheetCancel.addEventListener('click', () => el.sheet.close());
  el.name.addEventListener('input', () => { if (el.name.value.trim()) setNameError(null); });
  el.releaseForm.addEventListener('submit', submitRelease);
  el.releaseKeep.addEventListener('click', () => el.release.close());

  // เปิดแท็บกลับมาหลังหายไปนาน ให้ดึงตารางใหม่ คนอื่นอาจจองไปแล้ว
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (state.meta && Date.now() - hiddenAt > 60_000) loadDay();
  });

  // loadMeta จะเปลี่ยนเป็นวันนี้เองถ้าวันใน URL อยู่นอกช่วงที่จองได้
  const fromUrl = new URLSearchParams(location.search).get('date');
  if (fromUrl && /^\d{4}-\d{2}-\d{2}$/.test(fromUrl)) state.date = fromUrl;

  loadDay();
})();
