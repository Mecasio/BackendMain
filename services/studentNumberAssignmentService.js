const bcrypt = require("bcryptjs");
const fs = require("fs");
const nodemailer = require("nodemailer");
const path = require("path");
const QRCode = require("qrcode");
const { db, db3 } = require("../routes/database/database");
const { insertAuditLogEnrollment } = require("../utils/auditLogger");
const { logStudentHistoryFromActor } = require("../utils/studentHistoryLogger");

const backendRoot = path.join(__dirname, "..");
const STUDENT_NUMBER_ASSIGNMENT_LOCK_NAME = "student_number_assignment";
const STUDENT_NUMBER_ASSIGNMENT_LOCK_TIMEOUT_SECONDS = 60;

let studentNumberAssignmentQueue = Promise.resolve();

const withStudentNumberAssignmentLock = async (operation) => {
  const lockConnection = await db3.getConnection();

  try {
    const [lockRows] = await lockConnection.query(
      "SELECT GET_LOCK(?, ?) AS acquired",
      [
        STUDENT_NUMBER_ASSIGNMENT_LOCK_NAME,
        STUDENT_NUMBER_ASSIGNMENT_LOCK_TIMEOUT_SECONDS,
      ],
    );

    if (Number(lockRows?.[0]?.acquired) !== 1) {
      const error = new Error(
        "Student numbering is currently busy. Please try again.",
      );
      error.status = 503;
      throw error;
    }

    return await operation();
  } finally {
    try {
      await lockConnection.query("SELECT RELEASE_LOCK(?)", [
        STUDENT_NUMBER_ASSIGNMENT_LOCK_NAME,
      ]);
    } catch (error) {
      console.error("[student-number-assignment] failed to release lock:", error);
    } finally {
      lockConnection.release();
    }
  }
};

const enqueueStudentNumberAssignment = (operation) => {
  const queuedOperation = studentNumberAssignmentQueue
    .catch(() => undefined)
    .then(() => withStudentNumberAssignmentLock(operation));

  studentNumberAssignmentQueue = queuedOperation.catch(() => undefined);

  return queuedOperation;
};

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const normalizeText = (value) => String(value ?? "").trim();

const generateTemporaryPassword = () =>
  Math.random().toString(36).slice(-8).toUpperCase();

const getActiveSchoolYearYearPrefix = async (connection) => {
  const [[row]] = await connection.query(
    `SELECT yt.year_description
     FROM active_school_year_table asy
     INNER JOIN year_table yt ON yt.year_id = asy.year_id
     WHERE asy.astatus = 1
     LIMIT 1`,
  );

  const rawYearDescription = String(row?.year_description ?? "").trim();
  const digits = rawYearDescription.replace(/\D/g, "");
  const prefix = digits.slice(0, 4);

  if (prefix.length !== 4) {
    const error = new Error(
      "Active school year year_description is invalid for traditional student numbering.",
    );
    error.status = 400;
    throw error;
  }

  return prefix;
};

const generateNextTraditionalStudentNumber = async (connection) => {
  const prefix = await getActiveSchoolYearYearPrefix(connection);

  const [[row]] = await connection.query(
    `SELECT
       MAX(CAST(RIGHT(student_number, 4) AS UNSIGNED)) AS max_seq
     FROM student_numbering_table
     WHERE student_number REGEXP ?
     FOR UPDATE`,
    [`^${prefix}[0-9]{4}$`],
  );

  const nextSeq = Number(row?.max_seq || 0) + 1;
  const padded = String(nextSeq).padStart(4, "0");
  return `${prefix}${padded}`;
};

const getYearLevelDescriptionCandidates = (academicProgram) => {
  const normalizedAcademicProgram = Number(academicProgram);
  if (normalizedAcademicProgram === 1) {
    return ["MASTERAL", "MASTER", "MASTERS", "MASTER'S"];
  }
  if (normalizedAcademicProgram === 2) {
    return ["DOCTORAL", "DOCTORATE", "DOCTOR", "DOCTOR'S"];
  }
  return ["FIRST YEAR", "1ST YEAR", "FIRST"];
};

const getEnrollmentPersonColumns = async (connection) => {
  const [columns] = await connection.query("SHOW COLUMNS FROM person_table");
  return columns.map((column) => column.Field);
};

const copyApplicantProfileImage = async ({ sourceFilename, studentNumber }) => {
  if (!sourceFilename) return sourceFilename;

  try {
    const applicantDir = path.join(backendRoot, "uploads", "Applicant1by1");
    const studentDir = path.join(backendRoot, "uploads", "Student1by1");
    const uploadRootDir = path.join(backendRoot, "uploads");

    await fs.promises.mkdir(studentDir, { recursive: true });

    const applicantPath = path.join(applicantDir, sourceFilename);
    const uploadRootPath = path.join(uploadRootDir, sourceFilename);
    const sourcePath = fs.existsSync(applicantPath)
      ? applicantPath
      : fs.existsSync(uploadRootPath)
        ? uploadRootPath
        : null;

    if (!sourcePath) {
      console.warn(
        `[assign-uploaded-applicant-student-number] profile image not found: ${sourceFilename}`,
      );
      return sourceFilename;
    }

    const ext = path.extname(sourceFilename) || ".jpg";
    const studentProfileImg = `${studentNumber}_profile_image${ext}`;
    await fs.promises.copyFile(
      sourcePath,
      path.join(studentDir, studentProfileImg),
    );

    return studentProfileImg;
  } catch (error) {
    console.error(
      "[assign-uploaded-applicant-student-number] failed to copy profile image:",
      error,
    );
    return sourceFilename;
  }
};

const insertEnrollmentPerson = async ({
  connection,
  personData,
  enrollmentPersonId,
  studentNumber,
  studentProfileImg,
}) => {
  const enrollmentColumns = new Set(await getEnrollmentPersonColumns(connection));
  const insertData = {};

  Object.entries(personData).forEach(([key, value]) => {
    if (enrollmentColumns.has(key)) insertData[key] = value;
  });

  insertData.person_id = enrollmentPersonId;
  insertData.student_number = studentNumber;
  if (enrollmentColumns.has("profile_img")) {
    insertData.profile_img = studentProfileImg;
  }

  await connection.query("INSERT INTO person_table SET ?", insertData);
};

const getProgramMetadataForUploadedApplicant = async (connection, curriculumId) => {
  const [programRows] = await connection.query(
    `SELECT pt.program_id, pt.components, pt.academic_program
     FROM curriculum_table cct
     INNER JOIN program_table pt ON cct.program_id = pt.program_id
     WHERE cct.curriculum_id = ?
     LIMIT 1`,
    [curriculumId],
  );

  if (!programRows.length) {
    const error = new Error("Program metadata was not found for this applicant curriculum.");
    error.status = 404;
    throw error;
  }

  return programRows[0];
};

const getYearLevelIdForAcademicProgram = async (connection, academicProgram) => {
  const candidates = getYearLevelDescriptionCandidates(academicProgram);
  const placeholders = candidates.map(() => "?").join(", ");
  const [rows] = await connection.query(
    `SELECT year_level_id
     FROM year_level_table
     WHERE UPPER(TRIM(year_level_description)) IN (${placeholders})
     ORDER BY FIELD(UPPER(TRIM(year_level_description)), ${placeholders})
     LIMIT 1`,
    [...candidates, ...candidates],
  );

  return rows?.[0]?.year_level_id || 1;
};

const buildUploadedApplicantPersonData = ({
  uploadedApplicant,
  programMetadata,
  yearLevelId,
}) => ({
  campus: programMetadata.components,
  academicProgram: programMetadata.academic_program,
  program: uploadedApplicant.program,
  yearLevel: yearLevelId,
  last_name: uploadedApplicant.last_name,
  first_name: uploadedApplicant.first_name,
  middle_name: uploadedApplicant.middle_name,
  extension: uploadedApplicant.extension || null,
  emailAddress: uploadedApplicant.email_address,
  cellphoneNumber: uploadedApplicant.contact_num,
  presentStreet: uploadedApplicant.address,
  created_at: new Date(),
});

const copyApplicantRequirements = async ({
  connection,
  applicantPersonId,
  enrollmentPersonId,
}) => {
  const [requirements] = await db.query(
    "SELECT * FROM requirement_uploads WHERE person_id = ?",
    [applicantPersonId],
  );

  if (!requirements.length) {
    const error = new Error(
      "Cannot assign student number because no applicant requirements were found to copy.",
    );
    error.status = 400;
    throw error;
  }

  let copiedRequirementRows = 0;

  for (const req of requirements) {
    const [requirementInsertResult] = await connection.query(
      `INSERT INTO requirement_uploads
        (requirements_id, person_id, submitted_documents, file_path, original_name,
         remarks, status, document_status, registrar_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.requirements_id,
        enrollmentPersonId,
        req.submitted_documents,
        req.file_path,
        req.original_name,
        req.remarks,
        req.status,
        req.document_status,
        req.registrar_status,
        req.created_at,
      ],
    );
    copiedRequirementRows += requirementInsertResult.affectedRows || 0;
  }

  if (copiedRequirementRows !== requirements.length) {
    const error = new Error(
      `Cannot assign student number because only ${copiedRequirementRows} of ${requirements.length} requirements were copied.`,
    );
    error.status = 500;
    throw error;
  }
};

const createQrCode = async (studentNumber) => {
  const qrDir = path.join(backendRoot, "uploads", "QrCodeGenerated");
  await fs.promises.mkdir(qrDir, { recursive: true });

  const qrData = `${process.env.DB_HOST_LOCAL}:5173/student_qr_information/${studentNumber}`;
  const qrFilename = `${studentNumber}_qrcode.png`;
  await QRCode.toFile(path.join(qrDir, qrFilename), qrData, {
    color: { dark: "#000", light: "#FFF" },
    width: 300,
  });

  return qrFilename;
};

const sendStudentNumberEmail = async ({
  emailAddress,
  firstName,
  middleName,
  lastName,
  studentNumber,
  temporaryPassword,
}) => {
  const [[company]] = await db.query(
    "SELECT company_name, short_term FROM company_settings WHERE id = 1",
  );

  const companyName = company?.company_name || "Enrollment Office";
  const companyShort = company?.short_term || "";
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: `"${companyShort} Enrollment Office" <${process.env.EMAIL_USER}>`,
    to: emailAddress,
    subject: `Welcome to ${companyName} - Acceptance Confirmation`,
    text: `
Hi, ${firstName} ${middleName || ""} ${lastName},

Congratulations! You are now officially accepted and part of the ${companyName} community.

Please visit your respective college offices to tag your schedule to your account and obtain your class schedule.

Your Student Number is: ${studentNumber}
Your Email Address is: ${emailAddress}

Your temporary password is: ${temporaryPassword}

You may change your password and keep it secure.

Click the link below to log in:
${process.env.DB_HOST_LOCAL}:5173/login
    `.trim(),
  });
};

const assignStudentNumberFromApplicantPersonCore = async ({
  applicantPersonId,
  auditActorId = "unknown",
  auditActorRole = "registrar",
}) => {
  const normalizedApplicantPersonId = Number(applicantPersonId);
  if (!Number.isInteger(normalizedApplicantPersonId) || normalizedApplicantPersonId <= 0) {
    const error = new Error("Invalid applicant person id.");
    error.status = 400;
    throw error;
  }

  const [personRows] = await db.query(
    "SELECT * FROM person_table WHERE person_id = ? LIMIT 1",
    [normalizedApplicantPersonId],
  );

  if (!personRows.length) {
    const error = new Error("Applicant person not found.");
    error.status = 404;
    throw error;
  }

  const personData = personRows[0];
  if (
    Number(personData.program_assignment_pending) === 1 ||
    !personData.program
  ) {
    const error = new Error(
      "Cannot assign a student number until an authorized personnel assigns the applicant's course.",
    );
    error.status = 409;
    throw error;
  }
  const studentNumber = `${new Date().getFullYear()}${String(normalizedApplicantPersonId).padStart(5, "0")}`;
  const temporaryPassword = generateTemporaryPassword();
  const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

  const connection = await db3.getConnection();
  let emailSent = false;
  let emailErrorMessage = "";

  try {
    await connection.beginTransaction();

    const [existingStudentRows] = await connection.query(
      "SELECT student_number FROM student_numbering_table WHERE student_number = ? LIMIT 1",
      [studentNumber],
    );

    if (existingStudentRows.length) {
      const error = new Error("Student number is already assigned.");
      error.status = 409;
      throw error;
    }

    const [latestRows] = await connection.query(
      "SELECT person_id AS latest_person_id FROM person_table ORDER BY person_id DESC LIMIT 1 FOR UPDATE",
    );
    const enrollmentPersonId = Number(latestRows?.[0]?.latest_person_id || 0) + 1;
    const studentProfileImg = await copyApplicantProfileImage({
      sourceFilename: personData.profile_img,
      studentNumber,
    });

    await connection.query(
      "INSERT INTO student_numbering_table (student_number, person_id) VALUES (?, ?)",
      [studentNumber, enrollmentPersonId],
    );

    await connection.query(
      `INSERT INTO person_status_table
        (person_id, exam_status, requirements, residency, student_registration_status, exam_result, hs_ave)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [enrollmentPersonId, 0, 0, 0, 1, 0, 0],
    );

    await copyApplicantRequirements({
      connection,
      applicantPersonId: normalizedApplicantPersonId,
      enrollmentPersonId,
    });

    await connection.query(
      `INSERT INTO student_status_table
        (student_number, active_curriculum, enrolled_status, year_level_id, active_school_year_id, control_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentNumber, personData.program, 0, 0, 0, 0],
    );

    await insertEnrollmentPerson({
      connection,
      personData,
      enrollmentPersonId,
      studentNumber,
      studentProfileImg,
    });

    await connection.query(
      "INSERT INTO user_accounts (person_id, email, password, role, status) VALUES (?, ?, ?, 'student', 1)",
      [enrollmentPersonId, personData.emailAddress, hashedPassword],
    );

    await createQrCode(studentNumber);

    const roleLabel = formatAuditActorRole(auditActorRole);
    const studentName = [
      personData.last_name,
      personData.first_name,
      personData.middle_name,
    ]
      .filter(Boolean)
      .join(", ");

    await insertAuditLogEnrollment({
      actorId: auditActorId,
      role: auditActorRole,
      action: "STUDENT_NUMBER_ASSIGN",
      severity: "INFO",
      message: `${roleLabel} (${auditActorId}) assigned student number ${studentNumber} to ${studentName || `person_id ${normalizedApplicantPersonId}`}.`,
    });

    await logStudentHistoryFromActor({
      actorId: auditActorId,
      studentNumber,
      action: "assign_student_number",
      details: {
        student_name: [personData.first_name, personData.middle_name, personData.last_name]
          .filter(Boolean)
          .join(" "),
        generated_number: studentNumber,
      },
    });

    await connection.commit();

    try {
      if (!normalizeText(personData.emailAddress)) {
        throw new Error("Student email address is empty.");
      }

      await sendStudentNumberEmail({
        emailAddress: personData.emailAddress,
        firstName: personData.first_name,
        middleName: personData.middle_name,
        lastName: personData.last_name,
        studentNumber,
        temporaryPassword,
      });
      emailSent = true;
    } catch (error) {
      emailErrorMessage =
        error?.response || error?.message || "Failed to send email.";
      console.error(
        "[assign-uploaded-applicant-student-number] Email send failed:",
        error,
      );
    }

    try {
      await db.query("UPDATE user_accounts SET status = 0 WHERE person_id = ?", [
        normalizedApplicantPersonId,
      ]);
    } catch (error) {
      console.error(
        "[assign-uploaded-applicant-student-number] failed to disable applicant account:",
        error,
      );
    }

    return {
      success: true,
      applicant_person_id: normalizedApplicantPersonId,
      enrollment_person_id: enrollmentPersonId,
      student_number: studentNumber,
      email_sent: emailSent,
      message: emailSent
        ? "Student number assigned and email sent successfully."
        : `Student number assigned, but email was not sent. ${emailErrorMessage}`,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const getActiveSchoolYearId = async (connection) => {
  const [rows] = await connection.query(
    "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1",
  );
  return Number(rows?.[0]?.id || 0);
};

const assertUploadedApplicantCurriculumIsActive = async (connection, curriculumId) => {
  const [rows] = await connection.query(
    "SELECT curriculum_id, lock_status FROM curriculum_table WHERE curriculum_id = ? LIMIT 1",
    [curriculumId],
  );

  if (!rows.length) {
    const error = new Error("Curriculum was not found for this applicant.");
    error.status = 404;
    throw error;
  }

  if (Number(rows[0].lock_status) !== 1) {
    const error = new Error(
      "Applicant curriculum is not active. Only locked curricula (lock_status = 1) can be assigned.",
    );
    error.status = 400;
    throw error;
  }

  return rows[0];
};

const getAssignedStudentNumberForUploadedApplicant = async (connection, emailAddress) => {
  const [rows] = await connection.query(
    `SELECT snt.student_number, snt.person_id
     FROM person_table pt
     INNER JOIN student_numbering_table snt ON snt.person_id = pt.person_id
     WHERE LOWER(TRIM(pt.emailAddress)) = LOWER(TRIM(?))
     LIMIT 1`,
    [emailAddress],
  );

  return rows[0] || null;
};

const isStudentNumberTaken = async (
  connection,
  studentNumber,
  { excludeStudentNumber } = {},
) => {
  const normalized = normalizeText(studentNumber);
  if (!normalized) return false;

  const exclude = normalizeText(excludeStudentNumber);
  if (exclude && normalized === exclude) return false;

  const [rows] = await connection.query(
    "SELECT student_number FROM student_numbering_table WHERE student_number = ? LIMIT 1",
    [normalized],
  );

  return rows.length > 0;
};

const getTablesWithStudentNumberColumn = async (connection) => {
  const [dbRows] = await connection.query("SELECT DATABASE() AS dbName");
  const dbName = dbRows[0]?.dbName;
  const [tables] = await connection.query(
    `SELECT TABLE_NAME AS tableName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'student_number'`,
    [dbName],
  );

  return tables.map((row) => row.tableName);
};

const updateStudentNumberReferences = async (
  connection,
  oldStudentNumber,
  newStudentNumber,
  personId,
) => {
  const updatedTables = [];

  await connection.query("SET FOREIGN_KEY_CHECKS = 0");

  try {
    const tables = await getTablesWithStudentNumberColumn(connection);

    for (const table of tables) {
      const [result] = await connection.query(
        `UPDATE \`${table}\` SET student_number = ? WHERE student_number = ?`,
        [newStudentNumber, oldStudentNumber],
      );

      if (result.affectedRows > 0) {
        updatedTables.push({ table, rows: result.affectedRows });
      }
    }

    const pathUpdates = [
      { table: "person_table", column: "profile_img", where: "person_id = ?", whereParams: [personId] },
      { table: "user_accounts", column: "profile_picture", where: "person_id = ?", whereParams: [personId] },
      { table: "requirement_uploads", column: "file_path", where: "person_id = ?", whereParams: [personId] },
      { table: "requirement_uploads", column: "submitted_documents", where: "person_id = ?", whereParams: [personId] },
    ];

    for (const { table, column, where, whereParams } of pathUpdates) {
      const [cols] = await connection.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
      if (!cols.length) continue;

      const [result] = await connection.query(
        `UPDATE \`${table}\`
         SET \`${column}\` = REPLACE(\`${column}\`, ?, ?)
         WHERE ${where} AND \`${column}\` LIKE ?`,
        [oldStudentNumber, newStudentNumber, ...whereParams, `%${oldStudentNumber}%`],
      );

      if (result.affectedRows > 0) {
        const existing = updatedTables.find((entry) => entry.table === `${table}.${column}`);
        if (existing) {
          existing.rows += result.affectedRows;
        } else {
          updatedTables.push({ table: `${table}.${column}`, rows: result.affectedRows });
        }
      }
    }
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  }

  return updatedTables;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const renameStudentNumberAssets = async (oldStudentNumber, newStudentNumber) => {
  const renamedAssets = [];
  const dirs = [
    path.join(backendRoot, "uploads", "QrCodeGenerated"),
    path.join(backendRoot, "uploads", "Student1by1"),
    path.join(backendRoot, "uploads", "StudentOnlineDocuments"),
    path.join(backendRoot, "uploads"),
  ];

  const shouldRename = (filename) =>
    filename === `${oldStudentNumber}_qrcode.png` ||
    filename.startsWith(`${oldStudentNumber}_`);

  const newFilename = (filename) => {
    if (filename === `${oldStudentNumber}_qrcode.png`) {
      return `${newStudentNumber}_qrcode.png`;
    }

    return filename.replace(
      new RegExp(`^${escapeRegex(oldStudentNumber)}_`),
      `${newStudentNumber}_`,
    );
  };

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = await fs.promises.readdir(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.promises.stat(fullPath).catch(() => null);
      if (!stat?.isFile() || !shouldRename(entry)) continue;

      const destPath = path.join(dir, newFilename(entry));
      await fs.promises.rename(fullPath, destPath);
      renamedAssets.push({ from: entry, to: path.basename(destPath) });
    }
  }

  const newQrPath = path.join(
    backendRoot,
    "uploads",
    "QrCodeGenerated",
    `${newStudentNumber}_qrcode.png`,
  );

  if (!fs.existsSync(newQrPath)) {
    await createQrCode(newStudentNumber);
    renamedAssets.push({ from: null, to: `${newStudentNumber}_qrcode.png`, generated: true });
  }

  return renamedAssets;
};

const assignStudentNumberFromUploadedApplicantCore = async ({
  uploadedApplicant,
  studentNumber: requestedStudentNumber,
  auditActorId = "unknown",
  auditActorRole = "registrar",
}) => {
  if (!uploadedApplicant?.id) {
    const error = new Error("Uploaded applicant is required.");
    error.status = 400;
    throw error;
  }
  if (!normalizeText(uploadedApplicant.email_address)) {
    const error = new Error("Uploaded applicant email address is required.");
    error.status = 400;
    throw error;
  }

  const studentNumber = normalizeText(requestedStudentNumber);
  if (!studentNumber) {
    const error = new Error("Student number is required.");
    error.status = 400;
    throw error;
  }

  const connection = await db3.getConnection();
  let emailSent = false;
  let emailErrorMessage = "";
  let enrollmentPersonId = null;
  let temporaryPassword = "";
  let personData = null;

  try {
    await connection.beginTransaction();

    await assertUploadedApplicantCurriculumIsActive(connection, uploadedApplicant.program);

    const programMetadata = await getProgramMetadataForUploadedApplicant(
      connection,
      uploadedApplicant.program,
    );
    const yearLevelId = await getYearLevelIdForAcademicProgram(
      connection,
      programMetadata.academic_program,
    );
    const activeSchoolYearId = await getActiveSchoolYearId(connection);

    const [latestRows] = await connection.query(
      "SELECT person_id AS latest_person_id FROM person_table ORDER BY person_id DESC LIMIT 1 FOR UPDATE",
    );

    const alreadyAssigned = await getAssignedStudentNumberForUploadedApplicant(
      connection,
      uploadedApplicant.email_address,
    );

    if (alreadyAssigned) {
      const error = new Error(
        `Student number is already assigned: ${alreadyAssigned.student_number}`,
      );
      error.status = 409;
      throw error;
    }

    if (await isStudentNumberTaken(connection, studentNumber)) {
      const error = new Error("This student number already exists.");
      error.status = 409;
      throw error;
    }

    enrollmentPersonId = Number(latestRows?.[0]?.latest_person_id || 0) + 1;

    temporaryPassword = generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    personData = buildUploadedApplicantPersonData({
      uploadedApplicant,
      programMetadata,
      yearLevelId,
    });

    await insertEnrollmentPerson({
      connection,
      personData,
      enrollmentPersonId,
      studentNumber,
      studentProfileImg: null,
    });

    await connection.query(
      `INSERT INTO person_status_table
        (person_id, exam_status, requirements, residency, student_registration_status, exam_result, hs_ave)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [enrollmentPersonId, 0, 0, 0, 1, 0, 0],
    );

    await connection.query(
      "INSERT INTO student_numbering_table (student_number, person_id) VALUES (?, ?)",
      [studentNumber, enrollmentPersonId],
    );

    await connection.query(
      `INSERT INTO student_status_table
        (student_number, active_curriculum, enrolled_status, year_level_id, active_school_year_id, control_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentNumber, uploadedApplicant.program, 1, yearLevelId, activeSchoolYearId, 0],
    );

    await connection.query(
      "INSERT INTO user_accounts (person_id, email, password, role, status) VALUES (?, ?, ?, 'student', 1)",
      [enrollmentPersonId, uploadedApplicant.email_address, hashedPassword],
    );

    await createQrCode(studentNumber);

    const roleLabel = formatAuditActorRole(auditActorRole);
    const studentName = [
      uploadedApplicant.last_name,
      uploadedApplicant.first_name,
      uploadedApplicant.middle_name,
    ]
      .filter(Boolean)
      .join(", ");

    await insertAuditLogEnrollment({
      actorId: auditActorId,
      role: auditActorRole,
      action: "STUDENT_NUMBER_ASSIGN",
      severity: "INFO",
      message: `${roleLabel} (${auditActorId}) assigned student number ${studentNumber} to uploaded applicant ${studentName || uploadedApplicant.applicant_number || uploadedApplicant.id}.`,
    });

    await logStudentHistoryFromActor({
      actorId: auditActorId,
      studentNumber,
      action: "assign_student_number",
      details: {
        student_name: [uploadedApplicant.first_name, uploadedApplicant.middle_name, uploadedApplicant.last_name]
          .filter(Boolean)
          .join(" "),
        generated_number: studentNumber,
      },
    });

    await connection.commit();

    try {
      if (!normalizeText(uploadedApplicant.email_address)) {
        throw new Error("Student email address is empty.");
      }

      await sendStudentNumberEmail({
        emailAddress: uploadedApplicant.email_address,
        firstName: uploadedApplicant.first_name,
        middleName: uploadedApplicant.middle_name,
        lastName: uploadedApplicant.last_name,
        studentNumber,
        temporaryPassword,
      });
      emailSent = true;
    } catch (error) {
      emailErrorMessage =
        error?.response || error?.message || "Failed to send email.";
      console.error(
        "[assign-uploaded-applicant-student-number] Email send failed:",
        error,
      );
    }

    return {
      success: true,
      uploaded_applicant_id: uploadedApplicant.id,
      enrollment_person_id: enrollmentPersonId,
      student_number: studentNumber,
      email_sent: emailSent,
      message: emailSent
        ? "Student number assigned and email sent successfully."
        : `Student number assigned, but email was not sent. ${emailErrorMessage}`,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const assignTraditionalStudentNumberFromUploadedApplicantCore = async ({
  uploadedApplicant,
  auditActorId = "unknown",
  auditActorRole = "registrar",
}) => {
  const connection = await db3.getConnection();

  try {
    // Use the same transaction/locking as the core assignment for safe sequence generation.
    await connection.beginTransaction();

    // Generate a unique YYYY#### student number for the *current* active school year.
    const studentNumber = await generateNextTraditionalStudentNumber(connection);

    // Commit the sequence reservation point before running the heavy assignment logic.
    // We still rely on the global assignment lock (enqueueStudentNumberAssignment)
    // to prevent concurrent traditional number generation across requests.
    await connection.commit();

    // Reuse the existing assignment flow (creates person_table, numbering, status, etc.)
    return await assignStudentNumberFromUploadedApplicantCore({
      uploadedApplicant,
      studentNumber,
      auditActorId,
      auditActorRole,
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const changeStudentNumberFromUploadedApplicantCore = async ({
  uploadedApplicant,
  newStudentNumber: requestedNewStudentNumber,
  auditActorId = "unknown",
  auditActorRole = "registrar",
}) => {
  if (!uploadedApplicant?.id) {
    const error = new Error("Uploaded applicant is required.");
    error.status = 400;
    throw error;
  }
  if (!normalizeText(uploadedApplicant.email_address)) {
    const error = new Error("Uploaded applicant email address is required.");
    error.status = 400;
    throw error;
  }

  const newStudentNumber = normalizeText(requestedNewStudentNumber);
  if (!newStudentNumber) {
    const error = new Error("Student number is required.");
    error.status = 400;
    throw error;
  }

  const connection = await db3.getConnection();

  try {
    await connection.beginTransaction();

    const assigned = await getAssignedStudentNumberForUploadedApplicant(
      connection,
      uploadedApplicant.email_address,
    );

    if (!assigned) {
      const error = new Error("No student number is assigned to this uploaded applicant.");
      error.status = 404;
      throw error;
    }

    const oldStudentNumber = assigned.student_number;
    const personId = assigned.person_id;

    if (newStudentNumber === oldStudentNumber) {
      await connection.commit();
      return {
        success: true,
        unchanged: true,
        old_student_number: oldStudentNumber,
        student_number: newStudentNumber,
        updated_tables: [],
        renamed_assets: [],
        message: "Student number is unchanged.",
      };
    }

    if (await isStudentNumberTaken(connection, newStudentNumber, { excludeStudentNumber: oldStudentNumber })) {
      const error = new Error("This student number already exists.");
      error.status = 409;
      throw error;
    }

    const updatedTables = await updateStudentNumberReferences(
      connection,
      oldStudentNumber,
      newStudentNumber,
      personId,
    );

    const roleLabel = formatAuditActorRole(auditActorRole);
    const studentName = [
      uploadedApplicant.last_name,
      uploadedApplicant.first_name,
      uploadedApplicant.middle_name,
    ]
      .filter(Boolean)
      .join(", ");

    await insertAuditLogEnrollment({
      actorId: auditActorId,
      role: auditActorRole,
      action: "STUDENT_NUMBER_CHANGE",
      severity: "WARNING",
      message: `${roleLabel} (${auditActorId}) changed student number from ${oldStudentNumber} to ${newStudentNumber} for uploaded applicant ${studentName || uploadedApplicant.applicant_number || uploadedApplicant.id}.`,
    });

    await connection.commit();

    const renamedAssets = await renameStudentNumberAssets(oldStudentNumber, newStudentNumber);

    return {
      success: true,
      old_student_number: oldStudentNumber,
      student_number: newStudentNumber,
      updated_tables: updatedTables,
      renamed_assets: renamedAssets,
      message: `Student number changed from ${oldStudentNumber} to ${newStudentNumber}. Updated ${updatedTables.length} table reference(s), processed ${renamedAssets.length} asset(s).`,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  isStudentNumberTaken: async (connection, studentNumber, options) =>
    isStudentNumberTaken(connection, studentNumber, options),
  assignStudentNumberFromApplicantPerson: (payload) =>
    enqueueStudentNumberAssignment(() =>
      assignStudentNumberFromApplicantPersonCore(payload),
    ),
  assignStudentNumberFromUploadedApplicant: (payload) =>
    enqueueStudentNumberAssignment(() =>
      assignStudentNumberFromUploadedApplicantCore(payload),
    ),
  assignTraditionalStudentNumberFromUploadedApplicant: (payload) =>
    enqueueStudentNumberAssignment(() =>
      assignTraditionalStudentNumberFromUploadedApplicantCore(payload),
    ),
  changeStudentNumberFromUploadedApplicant: (payload) =>
    enqueueStudentNumberAssignment(() =>
      changeStudentNumberFromUploadedApplicantCore(payload),
    ),
};
