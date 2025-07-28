-- Adds clientName column to client_rejected_statistics_entity
ALTER TABLE client_rejected_statistics_entity ADD COLUMN clientName varchar(64) DEFAULT '' NOT NULL;

-- Create unique index to mirror entity constraint
CREATE UNIQUE INDEX IF NOT EXISTS IDX_client_rejected_addr_worker_time_reason ON client_rejected_statistics_entity(address, clientName, time, reason);

-- Index to speed up lookups by address and worker over time
CREATE INDEX IF NOT EXISTS IDX_client_rejected_addr_worker_time ON client_rejected_statistics_entity(address, clientName, time);
