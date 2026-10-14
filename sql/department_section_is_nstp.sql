-- Add NSTP flag to department sections.
-- Database: enrollment (db3)
-- Run once against the enrollment database.

USE enrollment;

ALTER TABLE dprtmnt_section_table
  ADD COLUMN is_nstp TINYINT(1) NOT NULL DEFAULT 0
  CHECK (is_nstp IN (0, 1));
