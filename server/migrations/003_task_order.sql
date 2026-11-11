-- Tasks created together share the same created_at, so ordering by time (then random id)
-- served them in an arbitrary order. A sequence number keeps the order they were added in.

ALTER TABLE tasks ADD COLUMN seq bigserial;
CREATE INDEX tasks_project_seq_idx ON tasks (project_id, seq);
