-- Class List / student_number query performance indexes
-- Database: enrollment (db3)
-- Run once. Skip any statement that reports "Duplicate key name".

USE enrollment;

-- enrolled_subject: department filter via curriculum, term filter, student grouping
ALTER TABLE enrolled_subject
  ADD INDEX idx_es_curriculum_active_sy (curriculum_id, active_school_year_id);

ALTER TABLE enrolled_subject
  ADD INDEX idx_es_active_sy_student (active_school_year_id, student_number);

ALTER TABLE enrolled_subject
  ADD INDEX idx_es_student_active_sy (student_number, active_school_year_id);

-- dprtmnt_curriculum_table: department IN (...) lookups
ALTER TABLE dprtmnt_curriculum_table
  ADD INDEX idx_dct_dprtmnt_curriculum (dprtmnt_id, curriculum_id);

ALTER TABLE dprtmnt_curriculum_table
  ADD INDEX idx_dct_curriculum_dprtmnt (curriculum_id, dprtmnt_id);

-- student_status_table: join on student + active school year
ALTER TABLE student_status_table
  ADD INDEX idx_sst_student_active_sy (student_number, active_school_year_id);

-- active_school_year_table: year + semester filter
ALTER TABLE active_school_year_table
  ADD INDEX idx_asyt_year_semester (year_id, semester_id);

-- student_numbering_table: student/person joins
ALTER TABLE student_numbering_table
  ADD INDEX idx_snt_student_number (student_number);

ALTER TABLE student_numbering_table
  ADD INDEX idx_snt_person_id (person_id);
