const mysql = require("mysql2/promise");

const getDbHost = () => {
  if (process.env.NODE_ENV === 'production') {
    return process.env.DB_HOST_PUBLIC;
  } else if (process.env.NODE_ENV === 'local') {
    return process.env.DB_HOST_LOCAL;
  } else {
    return 'localhost'; // fallback for development
  }
};

//MYSQL CONNECTION FOR ADMISSION
const db = mysql.createPool({
  host: getDbHost(),
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME1 || "admission",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const db3 = mysql.createPool({
  host: getDbHost(),
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME2 || "enrollment",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ✅ EXPORT BOTH
let pageAccessPermissionColumnsReady;
let programSlotsEStatusColumnReady;
let scholarshipTypeCodeColumnReady;
let unifastUnitColumnsReady;
let matriculationUnitColumnsReady;
let studentNumberingColumnsReady;
let applicantProgramAssignmentColumnReady;

const ensureApplicantProgramAssignmentColumn = async () => {
  if (!applicantProgramAssignmentColumnReady) {
    applicantProgramAssignmentColumnReady = (async () => {
      const [columns] = await db.query("SHOW COLUMNS FROM person_table");
      const existingColumns = new Set(columns.map((column) => column.Field));

      if (!existingColumns.has("program_assignment_pending")) {
        await db.query(
          "ALTER TABLE person_table ADD COLUMN program_assignment_pending TINYINT(1) NOT NULL DEFAULT 0 AFTER program",
        );
      }
    })().catch((error) => {
      applicantProgramAssignmentColumnReady = null;
      throw error;
    });
  }

  return applicantProgramAssignmentColumnReady;
};

const ensureStudentNumberingColumns = async () => {
  if (!studentNumberingColumnsReady) {
    studentNumberingColumnsReady = (async () => {
      const [columns] = await db3.query("SHOW COLUMNS FROM student_numbering_table");
      const existingColumns = new Set(columns.map((column) => column.Field));
      const createdAtColumn = columns.find((column) => column.Field === "created_at");

      if (!existingColumns.has("student_number_type")) {
        try {
          await db3.query(
            "ALTER TABLE student_numbering_table ADD COLUMN student_number_type VARCHAR(20) NULL DEFAULT NULL AFTER person_id",
          );
        } catch (error) {
          if (error.code !== "ER_DUP_FIELDNAME") throw error;
        }
      }

      if (!existingColumns.has("created_at")) {
        try {
          await db3.query(
            "ALTER TABLE student_numbering_table ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER student_number_type",
          );
        } catch (error) {
          if (error.code !== "ER_DUP_FIELDNAME") throw error;
        }
      } else if (createdAtColumn.Null === "YES" || createdAtColumn.Default == null) {
        await db3.query(
          "ALTER TABLE student_numbering_table MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
        );
      }

      // Infer branch only from the previous main format or this new format.
      await db3.query(
        `UPDATE student_numbering_table
         SET student_number_type = CASE UPPER(RIGHT(TRIM(student_number), 1))
           WHEN 'M' THEN 'Manila'
           WHEN 'C' THEN 'Cavite'
           ELSE student_number_type
         END
         WHERE (student_number_type IS NULL OR TRIM(student_number_type) = '')
           AND (
             TRIM(student_number) REGEXP '^[0-9]{2}-[0-9]{4}[MC]$'
             OR TRIM(student_number) REGEXP '^[0-9]{2}[0-9]+-[0-9]{5}[MC]$'
           )`,
      );
    })().catch((error) => {
      studentNumberingColumnsReady = null;
      throw error;
    });
  }

  return studentNumberingColumnsReady;
};

const ensurePageAccessPermissionColumns = async () => {
  if (!pageAccessPermissionColumnsReady) {
    pageAccessPermissionColumnsReady = (async () => {
      const requiredColumns = ["can_create", "can_edit", "can_delete"];
      const [columns] = await db3.query("SHOW COLUMNS FROM page_access");
      const existingColumns = new Set(columns.map((column) => column.Field));

      for (const column of requiredColumns) {
        if (!existingColumns.has(column)) {
          await db3.query(
            `ALTER TABLE page_access ADD COLUMN ${column} TINYINT(1) NOT NULL DEFAULT 0`,
          );
        }
      }
    })().catch((error) => {
      pageAccessPermissionColumnsReady = null;
      throw error;
    });
  }

  return pageAccessPermissionColumnsReady;
};

const ensureProgramSlotsEStatusColumn = async () => {
  if (!programSlotsEStatusColumnReady) {
    programSlotsEStatusColumnReady = (async () => {
      const [columns] = await db.query("SHOW COLUMNS FROM program_slots");
      const existingColumns = new Set(columns.map((column) => column.Field));

      if (!existingColumns.has("e_status")) {
        await db.query(
          "ALTER TABLE program_slots ADD COLUMN e_status TINYINT(1) NOT NULL DEFAULT 0",
        );
      }
    })().catch((error) => {
      programSlotsEStatusColumnReady = null;
      throw error;
    });
  }

  return programSlotsEStatusColumnReady;
};

const ensureScholarshipTypeCodeColumn = async () => {
  if (!scholarshipTypeCodeColumnReady) {
    scholarshipTypeCodeColumnReady = (async () => {
      const [columns] = await db3.query("SHOW COLUMNS FROM scholarship_type");
      const existingColumns = new Set(columns.map((column) => column.Field));

      if (!existingColumns.has("scholarship_code")) {
        await db3.query(
          "ALTER TABLE scholarship_type ADD COLUMN scholarship_code VARCHAR(255) NOT NULL DEFAULT '' AFTER id",
        );
      }
    })().catch((error) => {
      scholarshipTypeCodeColumnReady = null;
      throw error;
    });
  }

  return scholarshipTypeCodeColumnReady;
};

const ensureUnitColumns = async (tableName) => {
  const [columns] = await db3.query(`SHOW COLUMNS FROM ${tableName}`);
  const existingColumns = new Set(columns.map((column) => column.Field));
  const requiredColumns = [
    "laboratory_units",
    "computer_units",
    "academic_units_enrolled",
    "academic_units_nstp_enrolled",
  ];

  for (const column of requiredColumns) {
    if (!existingColumns.has(column)) {
      await db3.query(
        `ALTER TABLE ${tableName} ADD COLUMN ${column} DECIMAL(10,2) NOT NULL DEFAULT 0.00`,
      );
    }
  }
};

const ensureUnifastUnitColumns = async () => {
  if (!unifastUnitColumnsReady) {
    unifastUnitColumnsReady = (async () => {
      await ensureUnitColumns("unifast");
    })().catch((error) => {
      unifastUnitColumnsReady = null;
      throw error;
    });
  }

  return unifastUnitColumnsReady;
};

const ensureMatriculationUnitColumns = async () => {
  if (!matriculationUnitColumnsReady) {
    matriculationUnitColumnsReady = (async () => {
      await ensureUnitColumns("matriculation");
    })().catch((error) => {
      matriculationUnitColumnsReady = null;
      throw error;
    });
  }

  return matriculationUnitColumnsReady;
};

module.exports = {
  db,
  db3,
  ensurePageAccessPermissionColumns,
  ensureProgramSlotsEStatusColumn,
  ensureScholarshipTypeCodeColumn,
  ensureUnifastUnitColumns,
  ensureMatriculationUnitColumns,
  ensureStudentNumberingColumns,
  ensureApplicantProgramAssignmentColumn,
};
