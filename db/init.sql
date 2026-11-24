-- roombook ฐานข้อมูล
-- PostgreSQL รันไฟล์นี้ครั้งเดียวตอนสร้าง volume ใหม่
-- ถ้าแก้ไฟล์นี้แล้วอยากให้มีผล ต้องลบ volume ก่อน:  docker compose down -v

CREATE TABLE rooms (
    id        integer     PRIMARY KEY,
    code      varchar(16) NOT NULL UNIQUE,
    building  text        NOT NULL,
    capacity  integer     NOT NULL CHECK (capacity > 0)
);

CREATE TABLE bookings (
    id          bigserial    PRIMARY KEY,
    room_id     integer      NOT NULL REFERENCES rooms (id),
    date        date         NOT NULL,
    -- ห้องเปิด 08:00 ถึง 20:00 ช่องสุดท้ายเริ่ม 19:00
    start_hour  smallint     NOT NULL CHECK (start_hour BETWEEN 8 AND 19),
    booked_by   varchar(40)  NOT NULL CHECK (length(btrim(booked_by)) > 0),
    created_at  timestamptz  NOT NULL DEFAULT now(),

    -- กันจองช่องเดียวกันซ้ำในระดับฐานข้อมูล สองคนกดพร้อมกันจะได้แค่คนเดียว
    -- index ของ constraint นี้ใช้กับคำค้น WHERE room_id = ? AND date = ? ด้วย
    CONSTRAINT bookings_one_per_slot UNIQUE (room_id, date, start_hour)
);

INSERT INTO rooms (id, code, building, capacity) VALUES
    (1, 'L2-01', 'หอสมุด ชั้น 2', 4),
    (2, 'L2-02', 'หอสมุด ชั้น 2', 4),
    (3, 'L2-03', 'หอสมุด ชั้น 2', 6),
    (4, 'L3-01', 'หอสมุด ชั้น 3', 8),
    (5, 'L3-02', 'หอสมุด ชั้น 3', 12);
