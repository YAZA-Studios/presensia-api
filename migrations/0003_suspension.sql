-- Suspend organisasi oleh operator platform (konsol admin).
-- 0 = aktif, 1 = ditangguhkan (login & absensi diblokir tenant terkait).
ALTER TABLE orgs ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
