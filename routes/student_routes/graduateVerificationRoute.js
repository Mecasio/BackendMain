const express = require("express");
const router = express.Router();
const QRCode = require("qrcode");
const { db3 } = require("../database/database");
const fs = require("fs");
const path = require("path");

const REMARKS_PASSED = 1;

// academic_program values from program_table (see program_table.academic_program)
const ACADEMIC_PROGRAM_LABELS = {
  0: "Undergraduate",
  1: "Graduate",
  2: "TechVoc",
};

const formatStudent = (student) => {
  const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());

  const last = clean(student.last_name);
  const nameParts = [clean(student.first_name), clean(student.middle_name), clean(student.extension)].filter(
    Boolean,
  );

  return {
    student_number: student.student_number,
    full_name: last && nameParts.length ? `${last}, ${nameParts.join(" ")}`.toUpperCase() : last.toUpperCase(),
    profile_image: student.profile_img || null,
  };
};

/**
 * Runs the full "did this student complete their final term" check, exactly
 * as before, but as a reusable function so both the read-only verification
 * endpoint AND the new "mark as graduate" endpoint share one source of truth.
 * Now also carries academic_program (0=Undergrad,1=Grad,2=TechVoc) and the
 * active_school_year_id of the final term, so a caller can persist a record.
 */
const evaluateGraduationEligibility = async (studentNumber) => {
  const [studentRows] = await db3.query(
    `
    SELECT
      snt.student_number,
      pt.person_id,
      pt.first_name,
      pt.middle_name,
      pt.last_name,
      pt.extension,
      pt.profile_img
    FROM student_numbering_table snt
    INNER JOIN person_table pt ON pt.person_id = snt.person_id
    WHERE snt.student_number = ?
    LIMIT 1
    `,
    [studentNumber],
  );

  if (studentRows.length === 0) {
    return { found: false, message: "No student record found for this student number." };
  }

  const student = studentRows[0];

  // Curriculum the student's subjects were enrolled under, now also pulling
  // academic_program so callers know Undergrad / Graduate / TechVoc.
  const [curriculumRows] = await db3.query(
    `
    SELECT
      es.curriculum_id,
      ct.program_id,
      pgt.program_code,
      pgt.program_description,
      pgt.major,
      pgt.academic_program
    FROM enrolled_subject es
    LEFT JOIN curriculum_table ct ON ct.curriculum_id = es.curriculum_id
    LEFT JOIN program_table pgt ON pgt.program_id = ct.program_id
    WHERE es.student_number = ?
    ORDER BY es.id DESC
    LIMIT 1
    `,
    [studentNumber],
  );

  if (curriculumRows.length === 0 || !curriculumRows[0].curriculum_id) {
    return {
      found: true,
      isGraduate: false,
      reason: "No enrollment record was found for this student under any curriculum.",
      student: formatStudent(student),
      program: null,
    };
  }

  const { curriculum_id, program_id, program_code, program_description, major, academic_program } =
    curriculumRows[0];

  const program = {
    program_id,
    program_code,
    program_description,
    major,
    academic_program,
    academic_program_label: ACADEMIC_PROGRAM_LABELS[academic_program] ?? "Unknown",
  };

  // Terminal term of that curriculum (last year level, last semester)
  const [finalTermRows] = await db3.query(
    `
    SELECT year_level_id, semester_id
    FROM program_tagging_table
    WHERE curriculum_id = ?
    ORDER BY year_level_id DESC, semester_id DESC
    LIMIT 1
    `,
    [curriculum_id],
  );

  if (finalTermRows.length === 0) {
    return {
      found: true,
      isGraduate: false,
      reason: "This curriculum has no tagged subjects to evaluate against.",
      student: formatStudent(student),
      program,
    };
  }

  const { year_level_id: finalYearLevelId, semester_id: finalSemesterId } = finalTermRows[0];

  // Every subject required in that terminal term
  const [requiredCourses] = await db3.query(
    `
    SELECT ptt.course_id, ct.course_code, ct.course_description
    FROM program_tagging_table ptt
    INNER JOIN course_table ct ON ct.course_id = ptt.course_id
    WHERE ptt.curriculum_id = ? AND ptt.year_level_id = ? AND ptt.semester_id = ?
    `,
    [curriculum_id, finalYearLevelId, finalSemesterId],
  );

  if (requiredCourses.length === 0) {
    return {
      found: true,
      isGraduate: false,
      reason: "No subjects are tagged for the final term of this curriculum.",
      student: formatStudent(student),
      program,
    };
  }

  const requiredCourseIds = requiredCourses.map((c) => c.course_id);
  const placeholders = requiredCourseIds.map(() => "?").join(", ");

  // Did the student pass every one of those subjects? Also carry
  // active_school_year_id so we can record WHICH term they finished in.
  const [completedRows] = await db3.query(
    `
    SELECT
      es.course_id,
      es.final_grade,
      es.en_remarks,
      es.active_school_year_id,
      yt.year_description,
      smt.ordinal_label AS semester_label
    FROM enrolled_subject es
    LEFT JOIN active_school_year_table ast ON ast.id = es.active_school_year_id
    LEFT JOIN year_table yt ON yt.year_id = ast.year_id
    LEFT JOIN semester_table smt ON smt.semester_id = ast.semester_id
    WHERE es.student_number = ?
      AND es.curriculum_id = ?
      AND es.course_id IN (${placeholders})
    ORDER BY es.id DESC
    `,
    [studentNumber, curriculum_id, ...requiredCourseIds],
  );

  // Keep only the latest attempt per course (handles retakes)
  const latestByCourseId = new Map();
  for (const row of completedRows) {
    if (!latestByCourseId.has(row.course_id)) latestByCourseId.set(row.course_id, row);
  }

  const finalTermSubjects = requiredCourses.map((course) => {
    const record = latestByCourseId.get(course.course_id);
    return {
      course_code: course.course_code,
      course_description: course.course_description,
      final_grade: record?.final_grade ?? null,
      passed: record ? Number(record.en_remarks) === REMARKS_PASSED : false,
      school_year:
        record?.year_description != null ? `${record.year_description}-${Number(record.year_description) + 1}` : null,
      semester: record?.semester_label ?? null,
      active_school_year_id: record?.active_school_year_id ?? null,
    };
  });

  const isGraduate = finalTermSubjects.length > 0 && finalTermSubjects.every((s) => s.passed);

  const [[yearLevelRow]] = await db3.query(
    `SELECT ordinal_label FROM year_level_table WHERE year_level_id = ? LIMIT 1`,
    [finalYearLevelId],
  );
  const [[semesterRow]] = await db3.query(
    `SELECT ordinal_label FROM semester_table WHERE semester_id = ? LIMIT 1`,
    [finalSemesterId],
  );

  // Most common active_school_year_id among the passed final-term subjects —
  // this is the term we'll record as "graduated_school_year_id" if the
  // registrar confirms graduation.
  const passedSchoolYearIds = finalTermSubjects
    .filter((s) => s.passed && s.active_school_year_id)
    .map((s) => s.active_school_year_id);
  const graduatedSchoolYearId = passedSchoolYearIds.length ? passedSchoolYearIds[0] : null;

  return {
    found: true,
    isGraduate,
    student: formatStudent(student),
    person_id: student.person_id,
    curriculum_id,
    program,
    final_term: {
      year_level_id: finalYearLevelId,
      semester_id: finalSemesterId,
      year_level: yearLevelRow?.ordinal_label || null,
      semester: semesterRow?.ordinal_label || null,
      subjects: finalTermSubjects,
    },
    graduated_school_year_id: graduatedSchoolYearId,
    graduated_semester_id: isGraduate ? finalSemesterId : null,
  };
};

router.get("/tor-qr-information/:student_number", async (req, res) => {
  const studentNumber = String(req.params.student_number || "").trim();
  if (!studentNumber) {
    return res.status(400).json({ success: false, message: "Student number is required." });
  }

  try {
    // 1) Student record must exist
    const [studentRows] = await db3.query(
      `
      SELECT
        snt.student_number,
        pt.person_id,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        pt.extension,
        pt.profile_img
      FROM student_numbering_table snt
      INNER JOIN person_table pt ON pt.person_id = snt.person_id
      WHERE snt.student_number = ?
      LIMIT 1
      `,
      [studentNumber],
    );

    if (studentRows.length === 0) {
      return res.status(404).json({ success: false, message: "No student record found for this student number." });
    }

    const student = studentRows[0];

    // 2) GATE: student must have a portal account
    const [accountRows] = await db3.query(
      `SELECT id, status FROM user_accounts WHERE person_id = ? AND role = 'student' LIMIT 1`,
      [student.person_id],
    );

    if (accountRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "This student does not have a portal account yet, so no TOR QR has been issued.",
      });
    }

    // 3) GATE: the TOR QR file must already exist on disk — this is the exact
    //    file written by send_student_password_reminder, not a fresh regeneration.
    const torQrDir = path.join(__dirname, "..", "..", "uploads", "TORStudentQRCodeGenerated");
    const torQrFilename = `${studentNumber}_tor_qrcode.png`;
    const torQrPath = path.join(torQrDir, torQrFilename);

    if (!fs.existsSync(torQrPath)) {
      return res.status(404).json({
        success: false,
        message: "A TOR QR code has not been generated for this student yet.",
      });
    }

    // 4) Program/curriculum, for display only
    const [curriculumRows] = await db3.query(
      `
      SELECT pgt.program_code, pgt.program_description, pgt.major, pgt.academic_program
      FROM enrolled_subject es
      LEFT JOIN curriculum_table ct ON ct.curriculum_id = es.curriculum_id
      LEFT JOIN program_table pgt ON pgt.program_id = ct.program_id
      WHERE es.student_number = ?
      ORDER BY es.id DESC
      LIMIT 1
      `,
      [studentNumber],
    );

    const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());
    const nameParts = [clean(student.first_name), clean(student.middle_name), clean(student.extension)].filter(Boolean);
    const fullName = clean(student.last_name) && nameParts.length
      ? `${clean(student.last_name)}, ${nameParts.join(" ")}`.toUpperCase()
      : clean(student.last_name).toUpperCase();

    return res.json({
      success: true,
      student: {
        student_number: student.student_number,
        full_name: fullName,
        profile_image: student.profile_img || null,
      },
      program: curriculumRows[0] || null,
      account_status: accountRows[0].status,
      // served from the SAME uploads path the QR file was written to
      tor_qr_image_url: `/uploads/TORStudentQRCodeGenerated/${torQrFilename}`,
    });
  } catch (error) {
    console.error("TOR QR information lookup failed:", error);
    return res.status(500).json({ success: false, message: "Unable to load TOR QR information right now." });
  }
});

router.get("/tor-qr-status/:student_number", async (req, res) => {
  const studentNumber = String(req.params.student_number || "").trim();

  if (!studentNumber) {
    return res.status(400).json({ success: false, message: "Student number is required." });
  }

  try {
    const torQrDir = path.join(__dirname, "..", "..", "uploads", "TORStudentQRCodeGenerated");
    const torQrFilename = `${studentNumber}_tor_qrcode.png`;
    const torQrPath = path.join(torQrDir, torQrFilename);

    const hasQr = fs.existsSync(torQrPath);

    return res.json({
      success: true,
      has_qr: hasQr,
      tor_qr_image_url: hasQr ? `/uploads/TORStudentQRCodeGenerated/${torQrFilename}` : null,
    });
  } catch (error) {
    console.error("TOR QR status check failed:", error);
    return res.status(500).json({ success: false, message: "Unable to check TOR QR status right now." });
  }
});

/**
 * READ-ONLY verification, used by the public QR-scan page.
 * Now checks student_graduation_table FIRST — if the registrar has already
 * officially recorded this student as a graduate, we return that persisted
 * record (with an actual graduation_date) instead of recomputing everything.
 * If no record exists yet, falls back to the live eligibility check exactly
 * like before, but flags officially_recorded: false so the frontend can
 * distinguish "eligible but not yet confirmed by the registrar" from
 * "confirmed graduate."
 */
router.get("/verify-graduate/:student_number", async (req, res) => {
  const studentNumber = String(req.params.student_number || "").trim();

  if (!studentNumber) {
    return res.status(400).json({ success: false, message: "Student number is required." });
  }

  try {
    const [recordedRows] = await db3.query(
      `SELECT * FROM student_graduation_table WHERE student_number = ? LIMIT 1`,
      [studentNumber],
    );

    if (recordedRows.length > 0) {
      const record = recordedRows[0];

      const [studentRows] = await db3.query(
        `
        SELECT snt.student_number, pt.first_name, pt.middle_name, pt.last_name, pt.extension, pt.profile_img
        FROM student_numbering_table snt
        INNER JOIN person_table pt ON pt.person_id = snt.person_id
        WHERE snt.student_number = ?
        LIMIT 1
        `,
        [studentNumber],
      );

      const [[programRow]] = await db3.query(
        `SELECT program_code, program_description, major FROM program_table WHERE program_id = ? LIMIT 1`,
        [record.program_id],
      );

      return res.json({
        success: true,
        is_graduate: true,
        officially_recorded: true,
        student: studentRows[0] ? formatStudent(studentRows[0]) : { student_number: studentNumber },
        program: programRow
          ? {
              ...programRow,
              academic_program: record.academic_program,
              academic_program_label: ACADEMIC_PROGRAM_LABELS[record.academic_program] ?? "Unknown",
            }
          : null,
        graduation_date: record.graduation_date,

        verified_at: new Date().toISOString(),
      });
    }

    // No persisted record yet — fall back to the live check.
    const evaluation = await evaluateGraduationEligibility(studentNumber);

    if (!evaluation.found) {
      return res.status(404).json({ success: false, message: evaluation.message });
    }

    return res.json({
      success: true,
      is_graduate: evaluation.isGraduate,
      officially_recorded: false,
      reason: evaluation.reason,
      student: evaluation.student,
      program: evaluation.program,
      final_term: evaluation.final_term,
      verified_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Graduate verification failed:", error);
    return res.status(500).json({ success: false, message: "Unable to verify graduation status right now." });
  }
});

router.post("/mark-graduate/:student_number", async (req, res) => {
  const studentNumber = String(req.params.student_number || "").trim();
  const { verified_by, graduation_date, remarks } = req.body || {};

  if (!studentNumber) {
    return res.status(400).json({ success: false, message: "Student number is required." });
  }

  try {
    const evaluation = await evaluateGraduationEligibility(studentNumber);

    if (!evaluation.found) {
      return res.status(404).json({ success: false, message: evaluation.message });
    }

    if (!evaluation.isGraduate) {
      return res.status(409).json({
        success: false,
        message: "This student has not passed every subject in their final term yet.",
        final_term: evaluation.final_term,
      });
    }

    const safeGraduationDate = graduation_date || new Date().toISOString().slice(0, 10);

    await db3.query(
      `
      INSERT INTO student_graduation_table
        (student_number, person_id, curriculum_id, program_id, academic_program,
         graduated_school_year_id, graduated_semester_id, graduation_date,
        verified_by, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        curriculum_id = VALUES(curriculum_id),
        program_id = VALUES(program_id),
        academic_program = VALUES(academic_program),
        graduated_school_year_id = VALUES(graduated_school_year_id),
        graduated_semester_id = VALUES(graduated_semester_id),
        graduation_date = VALUES(graduation_date),
      
        verified_by = VALUES(verified_by),
        remarks = VALUES(remarks)
      `,
      [
        studentNumber,
        evaluation.person_id,
        evaluation.curriculum_id,
        evaluation.program.program_id,
        evaluation.program.academic_program,
        evaluation.graduated_school_year_id,
        evaluation.graduated_semester_id,
        safeGraduationDate,
     
        verified_by || null,
        remarks || null,
      ],
    );

    return res.json({
      success: true,
      message: "Student recorded as a graduate.",
      student: evaluation.student,
      program: evaluation.program,
      graduation_date: safeGraduationDate,
    });
  } catch (error) {
    console.error("Mark-graduate failed:", error);
    return res.status(500).json({ success: false, message: "Unable to record graduation right now." });
  }
});

router.get("/graduate-qr/:student_number", async (req, res) => {
  const studentNumber = String(req.params.student_number || "").trim();
  if (!studentNumber) {
    return res.status(400).json({ success: false, message: "Student number is required." });
  }

  try {
    let frontendUrl = (process.env.FRONTEND_URL || "").trim();
   

    if (frontendUrl && !/^https?:\/\//i.test(frontendUrl)) {
      frontendUrl = `http://${frontendUrl}`;
    }

    const verificationUrl = `${frontendUrl}/tor_qr_information/${encodeURIComponent(studentNumber)}`;

    const qrBuffer = await QRCode.toBuffer(verificationUrl, {
      color: { dark: "#000", light: "#FFF" },
      width: 300,
      margin: 1,
    });

    res.set("Content-Type", "image/png");
    res.send(qrBuffer);
  } catch (error) {
    console.error("Graduate QR generation failed:", error);
    res.status(500).json({ success: false, message: "Unable to generate verification QR code." });
  }
});

module.exports = router;