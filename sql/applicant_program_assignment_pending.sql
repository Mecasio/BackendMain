ALTER TABLE person_table
  ADD COLUMN IF NOT EXISTS program_assignment_pending TINYINT(1) NOT NULL DEFAULT 0 AFTER program;
