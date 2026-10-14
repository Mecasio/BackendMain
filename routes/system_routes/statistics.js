const express = require("express");
const { db, db3 } = require("../database/database");

const router = express.Router();


// ====================================================================
// ACTIVE SCHOOL YEAR — only rows where astatus = 1, joined so the
// frontend gets real labels (year_description / semester_description)
// instead of raw ids. This is the single source of truth for the
// "active school year" filter dropdowns.
// ====================================================================
router.get("/active_school_year", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT
        asy.id,
        asy.year_id,
        yt.year_description,
        asy.semester_id,
        st.semester_description,
        st.semester_code,
        asy.astatus,
        asy.active
      FROM active_school_year_table asy
      INNER JOIN year_table yt ON yt.year_id = asy.year_id
      INNER JOIN semester_table st ON st.semester_id = asy.semester_id
      WHERE asy.astatus = 1
      ORDER BY yt.year_description DESC, asy.semester_id ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching active school year:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/ecat-summary", async (req, res) => {
  try {
    const { campus, school_year, semester } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";
    const hasYear = school_year !== undefined && school_year !== "" && school_year !== "all";
    const hasSemester = semester !== undefined && semester !== "" && semester !== "all";

    // ── total_applied / total_pending — both read straight off
    // person_table, which has no semester link of its own (no
    // active_school_year_id, no semester_code column). Only campus/year
    // apply here; `semester` can't filter these two until person_table
    // itself carries that association.
    let totalAppliedFilter = "WHERE termsOfAgreement = 1";
    const totalAppliedParams = [];
    if (hasCampus) { totalAppliedFilter += " AND campus = ?"; totalAppliedParams.push(campus); }
    if (hasYear) { totalAppliedFilter += " AND YEAR(created_at) = ?"; totalAppliedParams.push(school_year); }

    let pendingFilter = "";
    const pendingParams = [];
    if (hasCampus) { pendingFilter += " AND p.campus = ?"; pendingParams.push(campus); }
    if (hasYear) { pendingFilter += " AND YEAR(p.created_at) = ?"; pendingParams.push(school_year); }

    // ── total_scheduled — exam_applicants → entrance_exam_schedule
    // carries active_school_year_id, so semester CAN be applied here via
    // a join to enrollment.active_school_year_table.
    const needsScheduledJoin = hasCampus || hasYear;
    let scheduledJoin = "";
    let scheduledFilter = "";
    const scheduledParams = [];
    if (needsScheduledJoin) {
      scheduledJoin += `
         INNER JOIN applicant_numbering_table ant3 ON ant3.applicant_number = ea3.applicant_id
         INNER JOIN person_table pt3 ON pt3.person_id = ant3.person_id
      `;
      if (hasCampus) { scheduledFilter += " AND pt3.campus = ?"; scheduledParams.push(campus); }
      if (hasYear) { scheduledFilter += " AND YEAR(pt3.created_at) = ?"; scheduledParams.push(school_year); }
    }
    if (hasSemester) {
      scheduledJoin += `
         INNER JOIN entrance_exam_schedule s3 ON s3.schedule_id = ea3.schedule_id
         INNER JOIN enrollment.active_school_year_table asy3 ON asy3.id = s3.active_school_year_id
      `;
      scheduledFilter += " AND asy3.semester_id = ?";
      scheduledParams.push(semester);
    }

    // ── total_finished — exam_results now carries active_school_year_id
    // directly (stamped at save time by /exam/save), so semester CAN be
    // applied here too, without needing the person_table join at all.
    const needsFinishedJoin = hasCampus || hasYear;
    let finishedJoin = "";
    let finishedFilter = "";
    const finishedParams = [];
    if (needsFinishedJoin) {
      finishedJoin += " INNER JOIN person_table pt4 ON pt4.person_id = er.person_id";
      if (hasCampus) { finishedFilter += " AND pt4.campus = ?"; finishedParams.push(campus); }
      if (hasYear) { finishedFilter += " AND YEAR(pt4.created_at) = ?"; finishedParams.push(school_year); }
    }
    if (hasSemester) {
      finishedJoin += " LEFT JOIN enrollment.active_school_year_table asy4 ON asy4.id = er.active_school_year_id";
      finishedFilter += " AND asy4.semester_id = ?";
      finishedParams.push(semester);
    }

    const [rows] = await db.execute(
      `
      SELECT
        (SELECT COUNT(*) FROM person_table ${totalAppliedFilter}) AS total_applied,

        (SELECT COUNT(*)
         FROM person_table p
         LEFT JOIN applicant_numbering_table ant ON ant.person_id = p.person_id
         LEFT JOIN exam_applicants ea ON ea.applicant_id = ant.applicant_number
         LEFT JOIN (
           SELECT ru.person_id, COUNT(DISTINCT ru.requirements_id) AS verified_count
           FROM requirement_uploads ru
           INNER JOIN requirements_table rt ON ru.requirements_id = rt.id
           WHERE ru.document_status = 'Documents Verified & ECAT'
             AND rt.category = 'Main'
             AND rt.is_verifiable = 1
           GROUP BY ru.person_id
         ) AS vdocs ON vdocs.person_id = p.person_id
         LEFT JOIN (
           SELECT p3.person_id, COUNT(rt2.id) AS total_required
           FROM person_table p3
           LEFT JOIN requirements_table rt2
             ON (rt2.applicant_type = p3.applyingAs OR rt2.applicant_type = 0)
            AND rt2.category = 'Main'
            AND rt2.is_verifiable = 1
           GROUP BY p3.person_id
         ) AS rtot ON rtot.person_id = p.person_id
         WHERE COALESCE(rtot.total_required, 0) > 0
           AND COALESCE(vdocs.verified_count, 0) >= rtot.total_required
           AND (ea.email_sent IS NULL OR ea.email_sent = 0)
           ${pendingFilter}
        ) AS total_pending,

        (SELECT COUNT(DISTINCT ea3.applicant_id)
         FROM exam_applicants ea3
         ${scheduledJoin}
         WHERE ea3.email_sent = 1
         ${scheduledFilter}
        ) AS total_scheduled,

        (SELECT COUNT(DISTINCT er.person_id)
         FROM exam_results er
         ${finishedJoin}
         WHERE 1=1 ${finishedFilter}
        ) AS total_finished
    `,
      [...totalAppliedParams, ...pendingParams, ...scheduledParams, ...finishedParams],
    );

    const overallParams = [];
    let overallFilter = "";
    if (hasCampus) { overallFilter = " AND pt5.campus = ?"; overallParams.push(campus); }
    const [[overallRow]] = await db.query(
      `
      SELECT COUNT(DISTINCT er5.person_id) AS overall_accommodated
      FROM exam_results er5
      INNER JOIN person_table pt5 ON pt5.person_id = er5.person_id
      WHERE 1=1 ${overallFilter}
    `,
      overallParams,
    );

    res.json({
      ...rows[0],
      overall_accommodated: Number(overallRow.overall_accommodated || 0),
    });
  } catch (err) {
    console.error("Error fetching ECAT summary:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/applicant-stats", async (req, res) => {
  try {
    const { gender, department_id, program_id, school_year, semester, campus } =
      req.query;

    // ---------------------------
    // Build dynamic WHERE filters
    // ---------------------------
    let where = "WHERE 1=1";
    const params = [];

    if (gender !== undefined && gender !== "all") {
      where += " AND pt.gender = ?";
      params.push(gender);
    }

    if (program_id) {
      where += " AND pt.program = ?";
      params.push(program_id);
    }

    if (department_id) {
      where += `
        AND EXISTS (
          SELECT 1 FROM program_table p
          JOIN dprtmnt_curriculum_table dct
            ON p.curriculum_id = dct.curriculum_id
          WHERE p.curriculum_id = pt.program
            AND dct.dprtmnt_id = ?
        )
      `;
      params.push(department_id);
    }

    if (school_year) {
      where += " AND YEAR(pt.created_at) = ?";
      params.push(school_year);
    }

    if (semester) {
      where += " AND pt.middle_code = ?";
      params.push(semester);
    }

    // Campus filter — company_settings.branches[].id === person_table.campus
    if (campus !== undefined && campus !== "" && campus !== "all") {
      where += " AND pt.campus = ?";
      params.push(campus);
    }

    // ---------------------------
    // Fetch Total
    // ---------------------------
    const [totalRows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table pt
      ${where}
    `,
      params,
    );

    // ---------------------------
    // Fetch Gender Counts
    // ---------------------------
    const [rawGender] = await db.query(
      `
      SELECT pt.gender, COUNT(*) AS total
      FROM person_table pt
      ${where}
      GROUP BY pt.gender
    `,
      params,
    );

    const genderCounts = rawGender.map((row) => ({
      gender:
        row.gender === 0 ? "Male" : row.gender === 1 ? "Female" : "Unknown",
      total: row.total,
    }));

    // ---------------------------
    // Terms Of Agreement
    // ---------------------------
    const [agreementRows] = await db.query(
      `
      SELECT COALESCE(pt.termsOfAgreement,0) AS status, COUNT(*) AS total
      FROM person_table pt
      ${where}
      GROUP BY COALESCE(pt.termsOfAgreement,0)
    `,
      params,
    );

    res.json({
      totalApplicants: totalRows[0].total,
      genderCounts,
      statusCounts: agreementRows,
    });
  } catch (err) {
    console.error("ERROR /applicant-stats:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.get("/applicants-per-month", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const sql = `
      SELECT
        DATE_FORMAT(created_at, '%Y-%m') AS month,
        COUNT(*) AS total
      FROM person_table
      ${hasCampus ? "WHERE campus = ?" : ""}
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY month ASC
    `;

    const [rows] = await db.query(sql, hasCampus ? [campus] : []);
    res.json(rows);
  } catch (error) {
    console.error("Error in /applicants-per-month:", error);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/applicants/total", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table
      WHERE termsOfAgreement = 1
      ${hasCampus ? "AND campus = ?" : ""}
    `,
      hasCampus ? [campus] : [],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/week", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table
      WHERE termsOfAgreement = 1
        AND YEARWEEK(created_at, 1) = YEARWEEK(NOW(), 1)
      ${hasCampus ? "AND campus = ?" : ""}
    `,
      hasCampus ? [campus] : [],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/month", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table
      WHERE termsOfAgreement = 1
        AND YEAR(created_at) = YEAR(NOW())
        AND MONTH(created_at) = MONTH(NOW())
      ${hasCampus ? "AND campus = ?" : ""}
    `,
      hasCampus ? [campus] : [],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/year", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table
      WHERE termsOfAgreement = 1
        AND YEAR(created_at) = YEAR(NOW())
      ${hasCampus ? "AND campus = ?" : ""}
    `,
      hasCampus ? [campus] : [],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/department/total", async (req, res) => {
  const { department_id, campus } = req.query;
  const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

  try {
    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table pt
      JOIN program_table prog
        ON pt.program = prog.curriculum_id
      JOIN dprtmnt_curriculum_table dct
        ON prog.curriculum_id = dct.curriculum_id
      WHERE pt.termsOfAgreement = 1
        AND dct.dprtmnt_id = ?
        ${hasCampus ? "AND pt.campus = ?" : ""}
    `,
      hasCampus ? [department_id, campus] : [department_id],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/department/week", async (req, res) => {
  const { department_id, campus } = req.query;
  const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

  try {
    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table pt
      JOIN program_table prog
        ON pt.program = prog.curriculum_id
      JOIN dprtmnt_curriculum_table dct
        ON prog.curriculum_id = dct.curriculum_id
      WHERE pt.termsOfAgreement = 1
        AND dct.dprtmnt_id = ?
        AND YEARWEEK(pt.created_at, 1) = YEARWEEK(NOW(), 1)
        ${hasCampus ? "AND pt.campus = ?" : ""}
    `,
      hasCampus ? [department_id, campus] : [department_id],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/department/month", async (req, res) => {
  const { department_id, campus } = req.query;
  const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

  try {
    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table pt
      JOIN program_table prog
        ON pt.program = prog.curriculum_id
      JOIN dprtmnt_curriculum_table dct
        ON prog.curriculum_id = dct.curriculum_id
      WHERE pt.termsOfAgreement = 1
        AND dct.dprtmnt_id = ?
        AND YEAR(pt.created_at) = YEAR(NOW())
        AND MONTH(pt.created_at) = MONTH(NOW())
        ${hasCampus ? "AND pt.campus = ?" : ""}
    `,
      hasCampus ? [department_id, campus] : [department_id],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/department/year", async (req, res) => {
  const { department_id, campus } = req.query;
  const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

  try {
    const [rows] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM person_table pt
      JOIN program_table prog
        ON pt.program = prog.curriculum_id
      JOIN dprtmnt_curriculum_table dct
        ON prog.curriculum_id = dct.curriculum_id
      WHERE pt.termsOfAgreement = 1
        AND dct.dprtmnt_id = ?
        AND YEAR(pt.created_at) = YEAR(NOW())
        ${hasCampus ? "AND pt.campus = ?" : ""}
    `,
      hasCampus ? [department_id, campus] : [department_id],
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/applicants/program/stats", async (req, res) => {
  const { program_id, campus } = req.query;
  const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

  if (!program_id) {
    return res.status(400).json({ error: "Missing program_id" });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT
        COUNT(pt.person_id) AS total_applicants,
        SUM(CASE WHEN pt.created_at BETWEEN DATE_SUB(NOW(), INTERVAL 7 DAY) AND NOW() THEN 1 ELSE 0 END) AS applicants_week,
        SUM(CASE WHEN pt.created_at BETWEEN DATE_SUB(NOW(), INTERVAL 30 DAY) AND NOW() THEN 1 ELSE 0 END) AS applicants_month
      FROM admission.person_status_table pst
      INNER JOIN admission.person_table pt ON pst.person_id = pt.person_id
      INNER JOIN enrollment.curriculum_table ct ON pt.program = ct.curriculum_id
      WHERE ct.program_id = ?
        ${hasCampus ? "AND pt.campus = ?" : ""}
    `,
      hasCampus ? [program_id, campus] : [program_id],
    );

    res.json(
      rows[0] || {
        total_applicants: 0,
        applicants_week: 0,
        applicants_month: 0,
      },
    );
  } catch (err) {
    console.error("Program stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/applicants/filter", async (req, res) => {
  let { department_id, program_code, campus } = req.query;

  // Normalize empty strings to null
  if (!department_id) department_id = null;
  if (!program_code) program_code = null;
  if (!campus) campus = null;

  try {
    const [rows] = await db.query(
      `
      SELECT
        p.*,
        ct.curriculum_id,
        pt.program_code,
        pt.program_description,
        dc.dprtmnt_id
      FROM person_table p
      LEFT JOIN db3.curriculum_table ct
        ON p.program = ct.curriculum_id
      LEFT JOIN db3.program_table pt
        ON ct.program_id = pt.program_id
      LEFT JOIN db3.dprtmnt_curriculum_table dc
        ON ct.curriculum_id = dc.curriculum_id
      WHERE
        (${department_id} IS NULL OR dc.dprtmnt_id = ?)
        AND (${program_code} IS NULL OR pt.program_code = ?)
        AND (${campus} IS NULL OR p.campus = ?)
    `,
      [department_id, program_code, campus],
    );

    res.json(rows);
  } catch (err) {
    console.error("Filter applicants failed:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/exam/completed-count", async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT COUNT(*) AS total FROM exam_results`);
    console.log("Exam count from DB:", rows[0].total); // Debug

    res.json({ total: rows[0].total });
  } catch (err) {
    console.error("Error fetching exam count:", err);
    res.status(500).send("Server error");
  }
});


router.get("/get_enrollment_statistic", async (req, res) => {
  try {
    const { campus } = req.query;

    let query = `
      SELECT
        COUNT(DISTINCT CASE WHEN p.academicProgram = 2 THEN p.person_id END) AS Techvoc,
        COUNT(DISTINCT CASE WHEN p.academicProgram = 1 THEN p.person_id END) AS Graduate,
        COUNT(DISTINCT CASE WHEN p.academicProgram = 0 THEN p.person_id END) AS Undergraduate,
        COUNT(DISTINCT CASE
          WHEN p.academicProgram IS NULL OR p.academicProgram NOT IN (0, 1, 2)
          THEN p.person_id
        END) AS AcademicProgramUnclassified,
        COUNT(DISTINCT CASE WHEN p.classifiedAs = 'Returnee' THEN p.person_id END) AS Returnee,
        COUNT(DISTINCT CASE WHEN p.classifiedAs = 'Shiftee' THEN p.person_id END) AS Shiftee,
        COUNT(DISTINCT CASE WHEN p.classifiedAs = 'Foreign Student' THEN p.person_id END) AS ForeignStudent,
        COUNT(DISTINCT CASE WHEN p.classifiedAs = 'Transferee' THEN p.person_id END) AS Transferee,
        COUNT(DISTINCT CASE
          WHEN p.classifiedAs IS NULL
            OR TRIM(p.classifiedAs) = ''
            OR p.classifiedAs NOT IN ('Returnee', 'Shiftee', 'Foreign Student', 'Transferee')
          THEN p.person_id
        END) AS ClassificationUnclassified,
        COUNT(DISTINCT p.person_id) AS TotalEnrolled
      FROM person_table p
      JOIN person_status_table ps
        ON p.person_id = ps.person_id
      JOIN student_numbering_table snt
        ON p.person_id = snt.person_id
      JOIN student_status_table sst
        ON snt.student_number = sst.student_number
      JOIN active_school_year_table sy
        ON sst.active_school_year_id = sy.id
      WHERE ps.student_registration_status = 1
        AND sst.enrolled_status = 1
        AND sy.astatus = 1
    `;

    const params = [];

    if (campus !== undefined && campus !== "" && campus !== "all") {
      query += " AND p.campus = ?";
      params.push(campus);
    }

    const [rows] = await db3.execute(query, params);

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// backend: server.js or routes file
router.get("/get-scheduled-applicants", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT applicant_id, schedule_id, email_sent
      FROM exam_applicants
      WHERE schedule_id IS NOT NULL
        AND email_sent = 1
    `);

    console.log("Scheduled applicants:", rows); // should log 1 row
    res.json({ total: rows.length, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get(
  "/get_enrollment_statistic/college/:yearDescription/:userDep",
  async (req, res) => {
    try {
      const { yearDescription, userDep } = req.params;
      const { campus } = req.query;
      const hasCampus =
        campus !== undefined && campus !== "" && campus !== "all";

      if (!yearDescription || !userDep) {
        return res
          .status(400)
          .json({ error: "Missing required parameters: year, dprtmnt_id" });
      }

      const query = `
      SELECT
        SUM(CASE WHEN academicProgram = 2 THEN 1 ELSE 0 END) AS Techvoc,
        SUM(CASE WHEN academicProgram = 1 THEN 1 ELSE 0 END) AS Graduate,
        SUM(CASE WHEN academicProgram = 0 THEN 1 ELSE 0 END) AS Undergraduate,
        SUM(CASE WHEN classifiedAs = 'Returnee' THEN 1 ELSE 0 END) AS Returnee,
        SUM(CASE WHEN classifiedAs = 'Shiftee' THEN 1 ELSE 0 END) AS Shiftee,
        SUM(CASE WHEN classifiedAs = 'Foreign Student' THEN 1 ELSE 0 END) AS ForeignStudent,
        SUM(CASE WHEN classifiedAs = 'Transferee' THEN 1 ELSE 0 END) AS Transferee
      FROM person_table 
      INNER JOIN dprtmnt_curriculum_table 
        ON person_table.program = dprtmnt_curriculum_table.curriculum_id
      WHERE dprtmnt_curriculum_table.dprtmnt_id = ? AND YEAR(person_table.created_at) = ?
      ${hasCampus ? "AND person_table.campus = ?" : ""}
    `;

      const [rows] = await db3.query(
        query,
        hasCampus
          ? [userDep, yearDescription, campus]
          : [userDep, yearDescription],
      );

      res.json(rows[0]);
      console.log("DATA: ", rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

router.get("/enrolled-count", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const [rows] = await db.execute(
      `SELECT COUNT(*) AS total FROM person_table
       WHERE (classifiedAs = 'Freshman (First Year)' OR classifiedAs = 'Transferee' OR classifiedAs = 'Returnee')
       ${hasCampus ? "AND campus = ?" : ""}`,
      hasCampus ? [campus] : [],
    );
    res.json({ total: rows[0].total });
  } catch (error) {
    console.error("Error fetching enrolled count:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ✅ Count how many registrar roles exist
router.get("/registrar_count", async (req, res) => {
  try {
    const [rows] = await db3.query(
      "SELECT COUNT(*) AS count FROM user_accounts WHERE role IN ('administrator', 'superadmin', 'technical')",
    );
    res.json({ count: rows[0].count });
  } catch (error) {
    console.error("Error fetching registrar count:", error);
    res
      .status(500)
      .json({ message: "Server error while fetching registrar count" });
  }
});

router.get("/course_count/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db3.execute(
      `
      SELECT
        COUNT(es.course_id) AS initial_course,
        SUM(CASE WHEN es.en_remarks = 1 AND (sy.astatus <> 1 OR es.fe_status = 1) THEN 1 ELSE 0 END) AS passed_course,
        SUM(CASE WHEN es.en_remarks = 2 AND (sy.astatus <> 1 OR es.fe_status = 1) THEN 1 ELSE 0 END) AS failed_course,
        SUM(CASE WHEN es.en_remarks = 3 AND (sy.astatus <> 1 OR es.fe_status = 1) THEN 1 ELSE 0 END) AS inc_course,
        SUM(CASE WHEN es.en_remarks = 4 AND (sy.astatus <> 1 OR es.fe_status = 1) THEN 1 ELSE 0 END) AS dropped_course,
        CASE
          WHEN SUM(CASE WHEN sy.astatus = 1 THEN 1 ELSE 0 END) > 0
            AND SUM(CASE WHEN sy.astatus = 1 AND es.fe_status = 1 THEN 1 ELSE 0 END) = SUM(CASE WHEN sy.astatus = 1 THEN 1 ELSE 0 END)
          THEN 1
          ELSE 0
        END AS current_courses_evaluated
      FROM enrolled_subject AS es
      JOIN student_numbering_table AS snt ON es.student_number = snt.student_number
      JOIN person_table AS pt ON snt.person_id = pt.person_id
      JOIN active_school_year_table AS sy ON es.active_school_year_id = sy.id
      WHERE pt.person_id = ?
    `,
      [id],
    );

    res.json(rows[0] || { initial_course: 0 });
    console.log(rows);
  } catch (error) {
    console.error("Error fetching course count:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/accepted-students-count", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const [rows] = await db3.execute(
      `
      SELECT COUNT(*) AS total
      FROM student_numbering_table snt
      ${hasCampus ? "INNER JOIN person_table pt ON pt.person_id = snt.person_id" : ""}
      ${hasCampus ? "WHERE pt.campus = ?" : ""};
    `,
      hasCampus ? [campus] : [],
    );

    res.json(rows[0]); // { total: 25 }
  } catch (err) {
    console.error("Error fetching accepted students count:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/current-enrolled-students-count", async (req, res) => {
  try {
    const { campus } = req.query;
    const hasCampus = campus !== undefined && campus !== "" && campus !== "all";

    const [rows] = await db3.execute(
      `
      SELECT COUNT(DISTINCT p.person_id) AS total
        FROM person_table p
        JOIN person_status_table ps 
          ON p.person_id = ps.person_id
        JOIN student_numbering_table snt 
          ON p.person_id = snt.person_id
        JOIN student_status_table sst 
          ON snt.student_number = sst.student_number
        JOIN active_school_year_table sy 
          ON sst.active_school_year_id = sy.id
        WHERE ps.student_registration_status = 1
          AND sst.enrolled_status = 1
          AND sy.astatus = 1
          ${hasCampus ? "AND p.campus = ?" : ""};
    `,
      hasCampus ? [campus] : [],
    );

    res.json(rows[0]); // { total: 25 }
  } catch (err) {
    console.error("Error fetching accepted students count:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
