ALTER TABLE proxy_requests
  ADD COLUMN rotation_cycle_started_at DATETIME NULL;

CREATE INDEX idx_proxy_requests_rotation_cycle_started_at
  ON proxy_requests (rotation_cycle_started_at);
