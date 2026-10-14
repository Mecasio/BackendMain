const fs = require("fs");
const path = require("path");
const {
  insertAuditLogEnrollment,
} = require("../utils/auditLogger");
const { logStudentHistoryFromActor } = require("../utils/studentHistoryLogger");
const { ensureStudentNumberingColumns } = require("../routes/database/database");

function startStudentNumberingSocketApi(io, {
  db,
  db3,
  bcrypt,
  transporter,
  QRCode,
  baseDir,
}) {
  const __dirname = baseDir;

  ensureStudentNumberingColumns().catch((error) => {
    console.error("[student-numbering] failed to prepare student_numbering_table:", error);
  });

  const applicantOnlineDocsDir = path.join(
    __dirname,
    "uploads",
    "ApplicantOnlineDocuments",
  );
  const studentOnlineDocsDir = path.join(
    __dirname,
    "uploads",
    "StudentOnlineDocuments",
  );

  const buildStudentRequirementFilename = (
    applicantNumber,
    studentNumber,
    filePath,
    shortLabelFallback = "Unknown",
  ) => {
    const sourceFilename = path.basename(String(filePath || ""));
    if (!sourceFilename) return "";

    const applicantPrefix = applicantNumber
      ? `${String(applicantNumber).trim()}_`
      : "";
    if (applicantPrefix && sourceFilename.startsWith(applicantPrefix)) {
      return `${studentNumber}_${sourceFilename.slice(applicantPrefix.length)}`;
    }

    const ext = path.extname(sourceFilename);
    const yearMatch = sourceFilename.match(/_(\d{4})[^/\\]*$/);
    const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());

    return `${studentNumber}_${shortLabelFallback}_${year}${ext}`;
  };

  const copyRequirementFileForEnrollment = async ({
    sourceFilename,
    targetFilename,
    applicantNumber,
    studentNumber,
    shortLabelFallback = "Unknown",
  }) => {
    if (!sourceFilename) {
      return { copied: false, filePath: "" };
    }

    const normalizedSource = path.basename(String(sourceFilename));
    const normalizedTarget =
      targetFilename ||
      buildStudentRequirementFilename(
        applicantNumber,
        studentNumber,
        normalizedSource,
        shortLabelFallback,
      );

    if (!normalizedTarget) {
      return { copied: false, filePath: normalizedSource };
    }

    if (!fs.existsSync(studentOnlineDocsDir)) {
      fs.mkdirSync(studentOnlineDocsDir, { recursive: true });
    }

    const sourcePath = path.join(applicantOnlineDocsDir, normalizedSource);
    const targetPath = path.join(studentOnlineDocsDir, normalizedTarget);

    if (!fs.existsSync(sourcePath)) {
      console.warn(
        `[assign-student-number] requirement file not found: ${sourcePath}`,
      );
      return { copied: false, filePath: normalizedTarget };
    }

    fs.copyFileSync(sourcePath, targetPath);
    return { copied: true, filePath: normalizedTarget };
  };
    const generateStudentNumber = async (person_data, connection) => {
      const [[yearRow]] = await db3.query(
        `SELECT yt.year_description AS yr
     FROM active_school_year_table asy
     JOIN year_table yt ON asy.year_id = yt.year_id
     WHERE asy.astatus = 1
     LIMIT 1`,
      );
      const yearMatch = String(yearRow?.yr || "").match(/(\d{2})\s*$/);
      if (!yearMatch) {
        throw new Error("The active school year is missing or has an invalid year description.");
      }
      const yy = yearMatch[1];

      const [[deptRow]] = await db3.query(
        `SELECT dt.components AS dept_components
 FROM dprtmnt_curriculum_table dct
 JOIN dprtmnt_table dt ON dct.dprtmnt_id = dt.dprtmnt_id
 WHERE dct.curriculum_id = ?
 LIMIT 1`,
        [person_data.program],
      );

      if (!deptRow) {
        throw new Error(`No department is linked to curriculum_id=${person_data.program}.`);
      }

      // ── Branch is derived from dprtmnt_table.components, NOT person_data.campus ──
      // components: 1 = Manila, 2 = Cavite. The department is authoritative here:
      // e.g. dept 12 "Earist (Cavite Branch)" and dept 13 "Graduate School ... (Cavite Branch)"
      // are Cavite regardless of what campus the applicant happened to select on the form.
      const deptComponents = deptRow.dept_components;

      const components = Number(deptComponents);
      if (components !== 1 && components !== 2) {
        throw new Error(
          `Cannot determine the branch for curriculum_id=${person_data.program}; department components must be 1 (Manila) or 2 (Cavite).`,
        );
      }
      const targetBranchName = components === 2 ? 'Cavite' : 'Manila';
      const studentNumberType = targetBranchName;
      const letter = studentNumberType === "Cavite" ? "C" : "M";


      // Serialize allocation through the student-number insert and transaction commit.
      const lockName = `student-number:${yy}:${studentNumberType}`;
      const [lockRows] = await connection.query(
        "SELECT GET_LOCK(?, 60) AS acquired",
        [lockName],
      );
      if (Number(lockRows?.[0]?.acquired) !== 1) {
        throw new Error(`Timed out waiting to generate a ${studentNumberType} student number.`);
      }

      try {
        const [[sequenceRow]] = await connection.query(
          `SELECT MAX(CAST(SUBSTRING(student_number, 4, 4) AS UNSIGNED)) AS max_seq
           FROM student_numbering_table
           WHERE student_number REGEXP ?`,
          [`^${yy}-[0-9]{4}${letter}$`],
        );

        const nextSequence = Number(sequenceRow?.max_seq || 0) + 1;
        if (nextSequence > 9999) {
          throw new Error(`The ${studentNumberType} student-number sequence for ${yy} is full.`);
        }

        return {
          studentNumber: `${yy}-${String(nextSequence).padStart(4, "0")}${letter}`,
          studentNumberType,
          lockName,
        };
      } catch (error) {
        await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
        throw error;
      }
    };

io.on("connection", (socket) => {
    socket.on("assign-student-number", async (payload) => {
      const conn = await db3.getConnection();
      const copiedRequirementFilesForRollback = [];
      let copiedProfileFileForRollback = "";
      let enrollmentCommitted = false;
      let connectionReleased = false;
      let studentNumberLockName = null;
      let student_number_type = null;
      try {
        await ensureStudentNumberingColumns();
        const person_id =
          typeof payload === "object" && payload !== null
            ? payload.person_id
            : payload;
        const auditActorId =
          typeof payload === "object" && payload !== null
            ? payload.audit_actor_id || "unknown"
            : "unknown";
        const auditActorRole =
          typeof payload === "object" && payload !== null
            ? payload.audit_actor_role || "administrator"
            : "administrator";

        // ── Fetch person from ADMISSION db ──────────────────────────────────────
        const [rows] = await db.query(
          `SELECT * FROM person_table AS pt WHERE person_id = ?`,
          [person_id],
        );

        if (rows.length === 0) {
          conn.release();
          return socket.emit("assign-student-number-result", {
            success: false,
            message: "Person not found.",
          });
        }

        const person_data = rows[0];
        if (
          Number(person_data.program_assignment_pending) === 1 ||
          !person_data.program
        ) {
          conn.release();
          return socket.emit("assign-student-number-result", {
            success: false,
            message:
              "Cannot assign a student number until an authorized personnel assigns the applicant's course.",
          });
        }
        const { emailAddress, first_name, middle_name, last_name } = person_data;

        const [[requirementCountRow]] = await db.query(
          `SELECT COUNT(*) AS requirement_count FROM requirement_uploads WHERE person_id = ?`,
          [person_id],
        );
        if (Number(requirementCountRow?.requirement_count || 0) === 0) {
          conn.release();
          return socket.emit("assign-student-number-result", {
            success: false,
            message: "Cannot assign student number because no applicant requirements were found to copy.",
          });
        }

        // ── Generate student number ──────────────────────────────────────────────
        let student_number;
        try {
          const generated = await generateStudentNumber(person_data, conn);
          student_number = generated.studentNumber;
          student_number_type = generated.studentNumberType;
          studentNumberLockName = generated.lockName;
        } catch (genErr) {
          console.error("[assign-student-number] generateStudentNumber failed:", genErr.message);
          conn.release();
          return socket.emit("assign-student-number-result", {
            success: false,
            message: genErr.message,
          });
        }

        const tempPassword = Math.random().toString(36).slice(-8).toUpperCase();
        const hashedPassword = await bcrypt.hash(tempPassword, 10);
        let studentProfileImg = person_data.profile_img;

        // ── Copy applicant 1×1 photo to Student1by1 folder ──────────────────────
        if (person_data.profile_img) {
          try {
            const applicantDir = path.join(__dirname, "uploads", "Applicant1by1");
            const studentDir = path.join(__dirname, "uploads", "Student1by1");
            const uploadRootDir = path.join(__dirname, "uploads");

            if (!fs.existsSync(studentDir)) fs.mkdirSync(studentDir, { recursive: true });

            const applicantPath = path.join(applicantDir, person_data.profile_img);
            const uploadRootPath = path.join(uploadRootDir, person_data.profile_img);
            const sourcePath = fs.existsSync(applicantPath)
              ? applicantPath
              : fs.existsSync(uploadRootPath)
                ? uploadRootPath
                : null;

            if (sourcePath) {
              const ext = path.extname(person_data.profile_img) || ".jpg";
              studentProfileImg = `${student_number}_profile_image${ext}`;
              fs.copyFileSync(sourcePath, path.join(studentDir, studentProfileImg));
              copiedProfileFileForRollback = studentProfileImg;
            } else {
              console.warn(`[assign-student-number] profile image not found for person_id=${person_id}`);
            }
          } catch (imgErr) {
            console.error(`[assign-student-number] failed to copy profile image for person_id=${person_id}`, imgErr);
          }
        }

        // ── Get uploaded requirements from ADMISSION db ──────────────────────────
        const [requirements] = await db.query(
          `SELECT * FROM requirement_uploads WHERE person_id = ?`,
          [person_id],
        );

        if (!requirements.length) {
          throw new Error(
            "Cannot assign student number because no applicant requirements were found to copy.",
          );
        }

        const [[applicantNumberRow]] = await db.query(
          `SELECT applicant_number FROM applicant_numbering_table WHERE person_id = ? LIMIT 1`,
          [person_id],
        );
        const applicantNumber = applicantNumberRow?.applicant_number || null;

        const requirementShortLabels = new Map();
        if (requirements.length) {
          const requirementIds = [
            ...new Set(
              requirements
                .map((req) => req.requirements_id)
                .filter((id) => id !== null && id !== undefined),
            ),
          ];
          if (requirementIds.length) {
            const [requirementRows] = await db.query(
              `SELECT id, short_label FROM requirements_table WHERE id IN (?)`,
              [requirementIds],
            );
            for (const row of requirementRows) {
              requirementShortLabels.set(row.id, row.short_label || "Unknown");
            }
          }
        }

        // ── BEGIN TRANSACTION in ENROLLMENT db ───────────────────────────────────
        await conn.beginTransaction();

        // ── Build values array matching the 148 columns (skipping person_id) ────
        // Column order matches your schema exactly: col 2 → col 149
        const personValues = [
          student_number,                        // 2   student_number
          studentProfileImg,                     // 3   profile_img
          person_data.campus,                    // 4   campus
          person_data.academicProgram,           // 5   academicProgram
          person_data.classifiedAs,              // 6   classifiedAs
          person_data.applyingAs,                // 7   applyingAs
          person_data.program,                   // 8   program
          person_data.program2,                  // 9   program2
          person_data.program3,                  // 10  program3
          person_data.yearLevel,                 // 11  yearLevel
          person_data.last_name,                 // 12  last_name
          person_data.first_name,                // 13  first_name
          person_data.middle_name,               // 14  middle_name
          person_data.extension,                 // 15  extension
          person_data.nickname,                  // 16  nickname
          person_data.height,                    // 17  height
          person_data.weight,                    // 18  weight
          person_data.lrnNumber,                 // 19  lrnNumber
          person_data.nolrnNumber,               // 20  nolrnNumber
          person_data.gender,                    // 21  gender
          person_data.pwdMember,                 // 22  pwdMember
          person_data.pwdType,                   // 23  pwdType
          person_data.pwdId,                     // 24  pwdId
          person_data.birthOfDate,               // 25  birthOfDate
          person_data.age,                       // 26  age
          person_data.birthPlace,                // 27  birthPlace
          person_data.languageDialectSpoken,     // 28  languageDialectSpoken
          person_data.citizenship,               // 29  citizenship
          person_data.religion,                  // 30  religion
          person_data.civilStatus,               // 31  civilStatus
          person_data.tribeEthnicGroup,          // 32  tribeEthnicGroup
          person_data.cellphoneNumber,           // 33  cellphoneNumber
          person_data.emailAddress,              // 34  emailAddress
          person_data.presentStreet,             // 35  presentStreet
          person_data.presentBarangay,           // 36  presentBarangay
          person_data.presentZipCode,            // 37  presentZipCode
          person_data.presentRegion,             // 38  presentRegion
          person_data.presentProvince,           // 39  presentProvince
          person_data.presentMunicipality,       // 40  presentMunicipality
          person_data.presentDswdHouseholdNumber,// 41  presentDswdHouseholdNumber
          person_data.sameAsPresentAddress,      // 42  sameAsPresentAddress
          person_data.permanentStreet,           // 43  permanentStreet
          person_data.permanentBarangay,         // 44  permanentBarangay
          person_data.permanentZipCode,          // 45  permanentZipCode
          person_data.permanentRegion,           // 46  permanentRegion
          person_data.permanentProvince,         // 47  permanentProvince
          person_data.permanentMunicipality,     // 48  permanentMunicipality
          person_data.permanentDswdHouseholdNumber, // 49 permanentDswdHouseholdNumber
          person_data.solo_parent,               // 50  solo_parent
          person_data.father_deceased,           // 51  father_deceased
          person_data.father_family_name,        // 52  father_family_name
          person_data.father_given_name,         // 53  father_given_name
          person_data.father_middle_name,        // 54  father_middle_name
          person_data.father_ext,                // 55  father_ext
          person_data.father_nickname,           // 56  father_nickname
          person_data.father_education,          // 57  father_education
          person_data.father_education_level,    // 58  father_education_level
          person_data.father_last_school,        // 59  father_last_school
          person_data.father_course,             // 60  father_course
          person_data.father_year_graduated,     // 61  father_year_graduated
          person_data.father_school_address,     // 62  father_school_address
          person_data.father_contact,            // 63  father_contact
          person_data.father_occupation,         // 64  father_occupation
          person_data.father_employer,           // 65  father_employer
          person_data.father_income,             // 66  father_income
          person_data.father_email,              // 67  father_email
          person_data.mother_deceased,           // 68  mother_deceased
          person_data.mother_family_name,        // 69  mother_family_name
          person_data.mother_given_name,         // 70  mother_given_name
          person_data.mother_middle_name,        // 71  mother_middle_name
          person_data.mother_ext,                // 72  mother_ext
          person_data.mother_nickname,           // 73  mother_nickname
          person_data.mother_education,          // 74  mother_education
          person_data.mother_education_level,    // 75  mother_education_level
          person_data.mother_last_school,        // 76  mother_last_school
          person_data.mother_course,             // 77  mother_course
          person_data.mother_year_graduated,     // 78  mother_year_graduated
          person_data.mother_school_address,     // 79  mother_school_address
          person_data.mother_contact,            // 80  mother_contact
          person_data.mother_occupation,         // 81  mother_occupation
          person_data.mother_employer,           // 82  mother_employer
          person_data.mother_income,             // 83  mother_income
          person_data.mother_email,              // 84  mother_email
          person_data.guardian,                  // 85  guardian
          person_data.guardian_family_name,      // 86  guardian_family_name
          person_data.guardian_given_name,       // 87  guardian_given_name
          person_data.guardian_middle_name,      // 88  guardian_middle_name
          person_data.guardian_ext,              // 89  guardian_ext
          person_data.guardian_nickname,         // 90  guardian_nickname
          person_data.guardian_address,          // 91  guardian_address
          person_data.guardian_contact,          // 92  guardian_contact
          person_data.guardian_email,            // 93  guardian_email
          person_data.spouse,                    // 94  spouse
          person_data.facebook_account,          // 95  facebook_account
          person_data.has_no_siblings,           // 96  has_no_siblings
          person_data.siblings,                  // 97  siblings
          person_data.annual_income,             // 98  annual_income
          person_data.schoolLevel,               // 99  schoolLevel
          person_data.schoolLastAttended,        // 100 schoolLastAttended
          person_data.schoolAddress,             // 101 schoolAddress
          person_data.courseProgram,             // 102 courseProgram
          person_data.honor,                     // 103 honor
          person_data.generalAverage,            // 104 generalAverage
          person_data.yearGraduated,             // 105 yearGraduated
          person_data.schoolLevel1,              // 106 schoolLevel1
          person_data.schoolLastAttended1,       // 107 schoolLastAttended1
          person_data.schoolAddress1,            // 108 schoolAddress1
          person_data.courseProgram1,            // 109 courseProgram1
          person_data.honor1,                    // 110 honor1
          person_data.generalAverage1,           // 111 generalAverage1
          person_data.yearGraduated1,            // 112 yearGraduated1
          person_data.strand,                    // 113 strand
          person_data.cough,                     // 114 cough
          person_data.colds,                     // 115 colds
          person_data.fever,                     // 116 fever
          person_data.asthma,                    // 117 asthma
          person_data.faintingSpells,            // 118 faintingSpells
          person_data.heartDisease,              // 119 heartDisease
          person_data.tuberculosis,              // 120 tuberculosis
          person_data.frequentHeadaches,         // 121 frequentHeadaches
          person_data.hernia,                    // 122 hernia
          person_data.chronicCough,              // 123 chronicCough
          person_data.headNeckInjury,            // 124 headNeckInjury
          person_data.hiv,                       // 125 hiv
          person_data.highBloodPressure,         // 126 highBloodPressure
          person_data.diabetesMellitus,          // 127 diabetesMellitus
          person_data.allergies,                 // 128 allergies
          person_data.cancer,                    // 129 cancer
          person_data.smokingCigarette,          // 130 smokingCigarette
          person_data.alcoholDrinking,           // 131 alcoholDrinking
          person_data.hospitalized,              // 132 hospitalized
          person_data.hospitalizationDetails,    // 133 hospitalizationDetails
          person_data.medications,               // 134 medications
          person_data.hadCovid,                  // 135 hadCovid
          person_data.covidDate,                 // 136 covidDate
          person_data.vaccine1Brand,             // 137 vaccine1Brand
          person_data.vaccine1Date,              // 138 vaccine1Date
          person_data.vaccine2Brand,             // 139 vaccine2Brand
          person_data.vaccine2Date,              // 140 vaccine2Date
          person_data.booster1Brand,             // 141 booster1Brand
          person_data.booster1Date,              // 142 booster1Date
          person_data.booster2Brand,             // 143 booster2Brand
          person_data.booster2Date,              // 144 booster2Date
          person_data.chestXray,                 // 145 chestXray
          person_data.cbc,                       // 146 cbc
          person_data.urinalysis,                // 147 urinalysis
          person_data.otherworkups,              // 148 otherworkups
          person_data.symptomsToday,             // 149 symptomsToday
          person_data.remarks,                   // 150 remarks
          person_data.termsOfAgreement,          // 151 termsOfAgreement
          person_data.created_at,                // 152 created_at
          person_data.current_step,              // 153 current_step
        ];

        const placeholders = personValues.map(() => "?").join(", ");

        const [personInsertResult] = await conn.query(
          `INSERT INTO person_table (
    student_number, profile_img, campus, academicProgram, classifiedAs,
    applyingAs, program, program2, program3, yearLevel, last_name, first_name,
    middle_name, extension, nickname, height, weight, lrnNumber, nolrnNumber,
    gender, pwdMember, pwdType, pwdId, birthOfDate, age, birthPlace,
    languageDialectSpoken, citizenship, religion, civilStatus, tribeEthnicGroup,
    cellphoneNumber, emailAddress, presentStreet, presentBarangay, presentZipCode,
    presentRegion, presentProvince, presentMunicipality, presentDswdHouseholdNumber,
    sameAsPresentAddress, permanentStreet, permanentBarangay, permanentZipCode,
    permanentRegion, permanentProvince, permanentMunicipality,
    permanentDswdHouseholdNumber, solo_parent, father_deceased, father_family_name,
    father_given_name, father_middle_name, father_ext, father_nickname,
    father_education, father_education_level, father_last_school, father_course,
    father_year_graduated, father_school_address, father_contact, father_occupation,
    father_employer, father_income, father_email, mother_deceased, mother_family_name,
    mother_given_name, mother_middle_name, mother_ext, mother_nickname,
    mother_education, mother_education_level, mother_last_school, mother_course,
    mother_year_graduated, mother_school_address, mother_contact, mother_occupation,
    mother_employer, mother_income, mother_email, guardian, guardian_family_name,
    guardian_given_name, guardian_middle_name, guardian_ext, guardian_nickname,
    guardian_address, guardian_contact, guardian_email, spouse, facebook_account,
    has_no_siblings, siblings, annual_income, schoolLevel,
    schoolLastAttended, schoolAddress, courseProgram, honor, generalAverage,
    yearGraduated, schoolLevel1, schoolLastAttended1, schoolAddress1, courseProgram1,
    honor1, generalAverage1, yearGraduated1, strand, cough, colds, fever, asthma,
    faintingSpells, heartDisease, tuberculosis, frequentHeadaches, hernia,
    chronicCough, headNeckInjury, hiv, highBloodPressure, diabetesMellitus,
    allergies, cancer, smokingCigarette, alcoholDrinking, hospitalized,
    hospitalizationDetails, medications, hadCovid, covidDate, vaccine1Brand,
    vaccine1Date, vaccine2Brand, vaccine2Date, booster1Brand, booster1Date,
    booster2Brand, booster2Date, chestXray, cbc, urinalysis, otherworkups,
    symptomsToday, remarks, termsOfAgreement, created_at, current_step
  ) VALUES (${placeholders})`,
          personValues,
        );

        if (!personInsertResult.insertId) {
          throw new Error("Cannot assign student number because the enrollment person record was not created.");
        }
        // ── Real person_id from MySQL auto-increment ─────────────────────────────
        const personIdForStudent = personInsertResult.insertId;

        // ── Insert into student_numbering_table ──────────────────────────────────
        const [studentNumberInsertResult] = await conn.query(
          `INSERT INTO student_numbering_table (student_number, person_id, student_number_type)
           VALUES (?, ?, ?)`,
          [student_number, personIdForStudent, student_number_type],
        );
        if ((studentNumberInsertResult.affectedRows || 0) !== 1) {
          throw new Error("Cannot assign student number because the student numbering record was not created.");
        }

        // ── Insert into person_status_table ──────────────────────────────────────
        const [personStatusInsertResult] = await conn.query(
          `INSERT INTO person_status_table
        (person_id, exam_status, requirements, residency, student_registration_status, exam_result, hs_ave)
       VALUES (?, 0, 0, 0, 0, 0, 0)`,
          [personIdForStudent],
        );
        if ((personStatusInsertResult.affectedRows || 0) !== 1) {
          throw new Error("Cannot assign student number because the enrollment person status was not created.");
        }

        // ── Insert into student_status_table ─────────────────────────────────────
        const [studentStatusInsertResult] = await conn.query(
          `INSERT INTO student_status_table
        (student_number, active_curriculum, enrolled_status, year_level_id, active_school_year_id, control_status)
       VALUES (?, ?, 0, 0, 0, 0)`,
          [student_number, person_data.program],
        );
        if ((studentStatusInsertResult.affectedRows || 0) !== 1) {
          throw new Error("Cannot assign student number because the enrollment student status was not created.");
        }

        // ── Copy requirements to ENROLLMENT db ───────────────────────────────────
        let copiedRequirementRows = 0;
        for (const req of requirements) {
          const shortLabel = requirementShortLabels.get(req.requirements_id) || "Unknown";
          const targetFilename = buildStudentRequirementFilename(
            applicantNumber,
            student_number,
            req.file_path,
            shortLabel,
          );
          const {
            copied: requirementFileCopied,
            filePath: enrollmentFilePath,
          } = await copyRequirementFileForEnrollment({
            sourceFilename: req.file_path,
            targetFilename,
            applicantNumber,
            studentNumber: student_number,
            shortLabelFallback: shortLabel,
          });
          if (req.file_path && !requirementFileCopied) {
            throw new Error(
              `Cannot assign student number because requirement file ${req.file_path} could not be copied.`,
            );
          }
          if (requirementFileCopied && enrollmentFilePath) {
            copiedRequirementFilesForRollback.push(enrollmentFilePath);
          }

          const [requirementInsertResult] = await conn.query(
            `INSERT INTO requirement_uploads
          (requirements_id, person_id, submitted_documents, file_path, original_name,
           remarks, status, document_status, registrar_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              req.requirements_id,
              personIdForStudent,
              req.submitted_documents,
              enrollmentFilePath || targetFilename || req.file_path,
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
          throw new Error(
            `Cannot assign student number because only ${copiedRequirementRows} of ${requirements.length} requirements were copied.`,
          );
        }

        // ── Mark student registration complete ───────────────────────────────────
        const [registrationStatusResult] = await conn.query(
          `UPDATE person_status_table SET student_registration_status = 1 WHERE person_id = ?`,
          [personIdForStudent],
        );
        if ((registrationStatusResult.affectedRows || 0) !== 1) {
          throw new Error("Cannot assign student number because student registration was not completed.");
        }

        // ── Insert or update login credentials in ENROLLMENT user_accounts ───────
        // ── Insert or update login credentials in ENROLLMENT user_accounts ───────
        const [existingUser] = await conn.query(
          `SELECT id FROM user_accounts WHERE person_id = ?`,
          [personIdForStudent],
        );

        if (existingUser.length === 0) {
          const [userInsertResult] = await conn.query(
            `INSERT INTO user_accounts (person_id, email, password, role, status, force_password_change)
 VALUES (?, ?, ?, 'student', 1, 1)`,
            [personIdForStudent, person_data.emailAddress, hashedPassword],
          );
          if ((userInsertResult.affectedRows || 0) !== 1) {
            throw new Error("Cannot assign student number because the student login account was not created.");
          }
        } else {
          const [userUpdateResult] = await conn.query(
            `UPDATE user_accounts SET email = ?, password = ?, role = 'student', status = 1, force_password_change = 1
 WHERE person_id = ?`,
            [person_data.emailAddress, hashedPassword, personIdForStudent],
          );
          if ((userUpdateResult.affectedRows || 0) !== 1) {
            throw new Error("Cannot assign student number because the student login account was not updated.");
          }
        }

        // ── Commit transaction ───────────────────────────────────────────────────
        await conn.commit();
        enrollmentCommitted = true;
        if (studentNumberLockName) {
          await conn.query("SELECT RELEASE_LOCK(?)", [studentNumberLockName]);
          studentNumberLockName = null;
        }
        conn.release();
        connectionReleased = true;

        const studentQrDir = path.join(__dirname, "uploads", "StudentQRCodeGenerated");
        if (!fs.existsSync(studentQrDir)) fs.mkdirSync(studentQrDir, { recursive: true });

        const qrFilename = `${student_number}_qrcode.png`;
        const studentQrData = `${process.env.DB_HOST_LOCAL}:5173/student_qr_information/${student_number}`;
        const studentQrPath = path.join(studentQrDir, qrFilename);

        await QRCode.toFile(studentQrPath, studentQrData, {
          color: { dark: "#000", light: "#FFF" },
          width: 300,
        });

        const torQrDir = path.join(__dirname, "uploads", "TORQrCodeGenerated");
        if (!fs.existsSync(torQrDir)) fs.mkdirSync(torQrDir, { recursive: true });

        const torQrData = `${process.env.DB_HOST_LOCAL}:5173/student_tor_information/${student_number}`;
        const torQrPath = path.join(torQrDir, qrFilename);

        await QRCode.toFile(torQrPath, torQrData, {
          color: { dark: "#000", light: "#FFF" },
          width: 300,
        });

        // ── Audit log ────────────────────────────────────────────────────────────
        const roleLabel = formatAuditActorRole(auditActorRole);
        const studentName = [last_name, first_name, middle_name].filter(Boolean).join(", ");

        await insertAuditLogEnrollment({
          actorId: auditActorId,
          role: auditActorRole,
          action: "STUDENT_NUMBER_ASSIGN",
          severity: "INFO",
          message: `${roleLabel} (${auditActorId}) assigned student number ${student_number} to ${studentName || `person_id ${person_id}`}.`,
        });

        await logStudentHistoryFromActor({
          actorId: auditActorId,
          studentNumber: student_number,
          action: "assign_student_number",
          details: {
            student_name: [first_name, middle_name, last_name].filter(Boolean).join(" "),
            generated_number: student_number,
          },
        });

        // ── Send welcome email ───────────────────────────────────────────────────
        const [[company]] = await db.query(
          "SELECT company_name, short_term FROM company_settings WHERE id = 1",
        );
        const companyName = company?.company_name || "Enrollment Office";
        const companyShort = company?.short_term || "";

        const mailer = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        let emailSent = false;
        let emailErrorMessage = "";

        try {
          if (!emailAddress) throw new Error("Student email address is empty.");
          await mailer.sendMail({
            from: `"${companyShort} Enrollment Office" <${process.env.EMAIL_USER}>`,
            to: emailAddress,
            subject: `Welcome to ${companyName} - Acceptance Confirmation`,
            text: `
Hi, ${first_name} ${middle_name || ""} ${last_name},

Congratulations! You are now officially accepted and part of the ${companyName} community.

Please visit your respective college offices to tag your schedule to your account and obtain your class schedule.

Your Student Number is: ${student_number}
Your Email Address is: ${emailAddress}
Your temporary password is: ${tempPassword}

You may change your password and keep it secure.

Click the link below to log in:
    https://ap.earist.edu.ph/login

    
        `.trim(),
          });
          emailSent = true;
        } catch (emailError) {
          emailErrorMessage = emailError?.response || emailError?.message || "Failed to send email.";
          console.error("[assign-student-number] Email send failed:", emailError);
        }

        // ── Deactivate the applicant account in ADMISSION ────────────────────────
        await db.query(
          `UPDATE user_accounts SET status = 0 WHERE person_id = ?`,
          [person_id],
        );

        // ── Emit result ──────────────────────────────────────────────────────────
        socket.emit("assign-student-number-result", {
          success: true,
          student_number,
          email_sent: emailSent,
          temp_password: tempPassword,
          student_data: {
            person_id: personIdForStudent + 1,
            student_number,
            first_name,
            middle_name,
            last_name,
            email: emailAddress,
            profile_img: studentProfileImg,
            program: person_data.program,
            campus: person_data.campus,
          },
          message: emailSent
            ? "Student number assigned and email sent successfully."
            : `Student number assigned, but email was not sent. ${emailErrorMessage}`,
        });

      } catch (error) {
        if (!enrollmentCommitted) {
          try { await conn.rollback(); } catch (_) { }
          for (const filename of copiedRequirementFilesForRollback) {
            const cleanupPath = path.join(studentOnlineDocsDir, path.basename(filename));
            try {
              if (fs.existsSync(cleanupPath)) fs.unlinkSync(cleanupPath);
            } catch (cleanupError) {
              console.error("[assign-student-number] failed to clean copied requirement file:", cleanupError);
            }
          }
          if (copiedProfileFileForRollback) {
            const cleanupPath = path.join(
              __dirname,
              "uploads",
              "Student1by1",
              path.basename(copiedProfileFileForRollback),
            );
            try {
              if (fs.existsSync(cleanupPath)) fs.unlinkSync(cleanupPath);
            } catch (cleanupError) {
              console.error("[assign-student-number] failed to clean copied profile image:", cleanupError);
            }
          }
        }
        if (studentNumberLockName) {
          try { await conn.query("SELECT RELEASE_LOCK(?)", [studentNumberLockName]); } catch (_) { }
          studentNumberLockName = null;
        }
        if (!connectionReleased) conn.release();

        console.error("Error in assign-student-number:", error);
        socket.emit("assign-student-number-result", {
          success: false,
          message: error.message || "Internal server error.",
        });
      }
    });
});
}

module.exports = { startStudentNumberingSocketApi };
