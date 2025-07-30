-- Track last share difficulty per worker
ALTER TABLE client_entity ADD COLUMN lastShareDiff real DEFAULT 0 NOT NULL;
