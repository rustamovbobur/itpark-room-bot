CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  authorized INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '{"step":"access"}',
  version INTEGER NOT NULL DEFAULT 0,
  last_update INTEGER NOT NULL DEFAULT -1,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
INSERT INTO rooms(id,name) VALUES (5,'Переговорная · 5-й этаж'),(6,'Переговорная · 6-й этаж'),(9,'Переговорная · 9-й этаж');
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  day TEXT NOT NULL,
  start_min INTEGER NOT NULL CHECK(start_min >= 0 AND start_min < 1440 AND start_min % 30 = 0),
  end_min INTEGER NOT NULL CHECK(end_min > start_min AND end_min <= 1440 AND end_min % 30 = 0),
  name TEXT NOT NULL,
  department TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at INTEGER NOT NULL,
  cancelled_by INTEGER,
  cancelled_at INTEGER
);
CREATE INDEX bookings_room_day ON bookings(room_id,day,status,start_min);
CREATE INDEX bookings_user_day ON bookings(user_id,day,status,start_min);
CREATE TABLE slot_numbers (n INTEGER PRIMARY KEY);
INSERT INTO slot_numbers(n) WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<47) SELECT n FROM seq;
CREATE TABLE booking_slots (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  day TEXT NOT NULL,
  minute INTEGER NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  PRIMARY KEY(room_id,day,minute)
);
CREATE INDEX slots_booking ON booking_slots(booking_id);
-- Every occupied half-hour is inserted in the SAME transaction as the booking.
-- A single occupied slot aborts the entire insertion, including earlier slots.
CREATE TRIGGER booking_reserve AFTER INSERT ON bookings WHEN NEW.status='active' BEGIN
  INSERT INTO booking_slots(room_id,day,minute,booking_id)
  SELECT NEW.room_id,NEW.day,NEW.start_min+n*30,NEW.id
  FROM slot_numbers WHERE NEW.start_min+n*30 < NEW.end_min;
END;
CREATE TRIGGER booking_release AFTER UPDATE OF status ON bookings
WHEN OLD.status='active' AND NEW.status='cancelled' BEGIN
  DELETE FROM booking_slots WHERE booking_id=NEW.id;
END;
CREATE TRIGGER booking_immutable BEFORE UPDATE OF room_id,day,start_min,end_min,user_id ON bookings BEGIN
  SELECT RAISE(ABORT,'booking_is_immutable');
END;
CREATE TRIGGER no_reactivation BEFORE UPDATE OF status ON bookings
WHEN OLD.status='cancelled' AND NEW.status!='cancelled' BEGIN
  SELECT RAISE(ABORT,'cannot_reactivate_booking');
END;
-- A failed optimistic user-state update rolls back the whole batch.
CREATE TABLE state_guard (ok INTEGER NOT NULL CONSTRAINT stale_state CHECK(ok=1));
CREATE TABLE receipts (
  update_id INTEGER PRIMARY KEY,
  response TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX receipts_age ON receipts(created_at);
