const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { db, db3 } = require("../database/database");
const QRCode = require("qrcode");
const router = express.Router();

const {
  GWA_UNIT_SQL,
  GWA_EXCLUSION_SQL,
  gwaGradeJoinSql,
} = require("../../utils/gwaSql");

const upload = multer({ storage: multer.memoryStorage() });

const ACADEMIC_PROGRAM_LABELS = {
  0: "Undergraduate",
  1: "Graduate",
  2: "TechVoc",
};


async function getRegistrarScope(employee_id) {
  const [rows] = await db3.query(
    `SELECT dprtmnt_id, program_id FROM registrar_scope_table WHERE employee_id = ?`,
    [employee_id],
  );
  return rows;
}

// Filters enrolled_subject down to ONE student before ranking, so the
// window function only ever ranks a handful of rows instead of the
// whole enrolled_subject table.
async function isStudentInRegistrarScope(student_number, employee_id) {
  const [[row]] = await db3.query(
    `
    SELECT 1 AS in_scope
    FROM (
      SELECT
        dct.dprtmnt_id,
        cct.program_id,
        ROW_NUMBER() OVER (
          ORDER BY sy.year_id DESC, sy.semester_id DESC, es.id DESC
        ) AS rn
      FROM enrolled_subject es
      INNER JOIN active_school_year_table sy ON sy.id = es.active_school_year_id
      INNER JOIN curriculum_table cct ON cct.curriculum_id = es.curriculum_id
      INNER JOIN dprtmnt_curriculum_table dct ON dct.curriculum_id = cct.curriculum_id
      WHERE es.student_number = ?
    ) ranked
    WHERE ranked.rn = 1
      AND EXISTS (
        SELECT 1 FROM registrar_scope_table rst
        WHERE rst.employee_id = ?
          AND rst.dprtmnt_id = ranked.dprtmnt_id
          AND rst.program_id = ranked.program_id
      )
    LIMIT 1
    `,
    [student_number, employee_id],
  );
  return Boolean(row);
}

// Runs the scope check ONCE and returns a reusable result, so callers that
// need both the scope list and the in-scope boolean don't hit the DB twice.
async function checkRegistrarAccess(student_number, employee_id) {
  const scope = await getRegistrarScope(employee_id);
  if (scope.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "No program/department access has been assigned to this account.",
    };
  }

  const inScope = await isStudentInRegistrarScope(student_number, employee_id);
  if (!inScope) {
    return {
      ok: false,
      status: 403,
      error: "You do not have access to this student's records.",
    };
  }

  return { ok: true };
}

router.get("/student-info", async (req, res) => {
  const { searchQuery, employee_id } = req.query;

  try {
    if (!searchQuery) {
      return res.status(400).json({ error: "searchQuery is required" });
    }

    // Fast path: searchQuery is already an exact student number (this is
    // the common case — it's called right after the autocomplete selects
    // a student). Avoids the unindexable LIKE '%...%' scan below.
    let student_number = null;

    const [exactMatch] = await db3.query(
      `SELECT student_number FROM student_numbering_table WHERE student_number = ? LIMIT 1`,
      [searchQuery],
    );

    if (exactMatch.length > 0) {
      student_number = exactMatch[0].student_number;
    } else {
      // Fallback: fuzzy search by name/email.
      const keyword = `%${searchQuery}%`;
      const [searchStudentNumber] = await db3.query(
        `
        SELECT snt.student_number
        FROM student_numbering_table snt
        INNER JOIN person_table pt ON snt.person_id = pt.person_id
        WHERE 
          pt.emailAddress = ?
          OR pt.first_name LIKE ?
          OR pt.last_name LIKE ?
          OR pt.middle_name LIKE ?
        LIMIT 1
        `,
        [searchQuery, keyword, keyword, keyword],
      );

      if (searchStudentNumber.length === 0) {
        return res.status(400).json({ error: "student is not found" });
      }
      student_number = searchStudentNumber[0].student_number;
    }

    if (employee_id) {
      const access = await checkRegistrarAccess(student_number, employee_id);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }
    }

    const [rows] = await db3.query(
      `
        SELECT
          pst.first_name,
          pst.middle_name,
          pst.last_name, 
          pst.presentStreet,
          pst.emailAddress,
          pst.cellphoneNumber,
          pst.campus,
          pst.presentBarangay,
          pst.presentZipCode,
          pst.presentMunicipality,
          pgt.program_description, 
          yrt_cur.year_description, 
          yrt_sy.year_description AS current_year, 
          smt.semester_description,
          snt.student_number,
          sst.year_level_id,
          ylt.year_level_description
        FROM student_numbering_table snt
        INNER JOIN enrolled_subject es 
            ON es.student_number = snt.student_number
        INNER JOIN person_table pst 
            ON pst.person_id = snt.person_id
        INNER JOIN student_status_table sst 
            ON sst.student_number = snt.student_number 
            AND sst.active_school_year_id = es.active_school_year_id
        INNER JOIN curriculum_table cct 
            ON cct.curriculum_id = es.curriculum_id
        INNER JOIN program_table pgt 
            ON pgt.program_id = cct.program_id
        INNER JOIN active_school_year_table sy 
            ON sy.id = es.active_school_year_id
        INNER JOIN year_table yrt_cur 
            ON yrt_cur.year_id = cct.year_id
        INNER JOIN year_table yrt_sy 
            ON yrt_sy.year_id = sy.year_id
        INNER JOIN year_level_table ylt 
            ON ylt.year_level_id = sst.year_level_id
        INNER JOIN semester_table smt 
            ON smt.semester_id = sy.semester_id
        WHERE snt.student_number = ?
        ORDER BY 
          sy.year_id DESC,
          sst.year_level_id DESC
        LIMIT 1;
      `,
      [student_number],
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: "student record is not found" });
    }

    res.json(rows);
  } catch (err) {
    console.error("Failed to get student record:", err);
    res.status(500).send("Failed to get student record.");
  }
});

router.get("/student-info/:student_number", async (req, res) => {
  const { student_number } = req.params;
  const { employee_id } = req.query;

  try {
    if (employee_id) {
      const access = await checkRegistrarAccess(student_number, employee_id);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }
    }

    const [rows] = await db3.query(
      `
        SELECT DISTINCT
          es.id,
          cct.curriculum_id,
          sy.id as active_school_year_id, 
          pgt.program_description, 
          yrt_cur.year_description, 
          yrt_sy.year_description AS current_year, 
          smt.semester_description,
          snt.student_number,
          IFNULL(es.final_grade, "-") as final_grade,
          es.grades_status,
          IFNULL(es.en_remarks, 0) as en_remarks,
          ylt.year_level_description, 
          cst.course_id,
          cst.course_code,
          cst.course_description,
          cst.course_unit,
          es.is_regular,
          es.remarks,
          sst.id AS student_status_id
        FROM enrolled_subject es
          INNER JOIN student_numbering_table snt ON es.student_number = snt.student_number
          INNER JOIN student_status_table sst ON snt.student_number = sst.student_number
            AND es.active_school_year_id = sst.active_school_year_id
          INNER JOIN curriculum_table cct ON es.curriculum_id = cct.curriculum_id
          INNER JOIN program_table pgt ON cct.program_id = pgt.program_id
          INNER JOIN active_school_year_table sy ON es.active_school_year_id = sy.id
          INNER JOIN year_table yrt_cur ON cct.year_id = yrt_cur.year_id
          INNER JOIN year_table yrt_sy ON sy.year_id = yrt_sy.year_id
          INNER JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id 
          INNER JOIN semester_table smt ON sy.semester_id = smt.semester_id
          INNER JOIN course_table cst ON es.course_id = cst.course_id
          WHERE es.student_number = ? ORDER BY ylt.year_level_id, es.id;
      `,
      [student_number],
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: "student record is not found" });
    }

    res.json(rows);
  } catch (err) {
    console.error("Failed to get student record:", err);
    res.status(500).send("Failed to get student record.");
  }
});
router.put("/update_student_year_level", async (req, res) => {
  const { new_year_level_id, id } = req.body;

  try {
    if (!new_year_level_id || !id) {
      return res.status(400).json({ message: "Missing required variables." });
    }

    await db3.query(
      `UPDATE student_status_table SET year_level_id = ? WHERE id = ?`,
      [new_year_level_id, id],
    );

    res
      .status(200)
      .json({ message: "Student Year Level was successfully changed." });
  } catch (err) {
    console.log("Internal Server Error: " + err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/student_schedule/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db3.execute(
      `
    SELECT DISTINCT
      ct.course_description,
      ct.course_code,
      ct.course_unit,
      ct.lab_unit,
      pgt.program_code,
      st.description AS section_description,
      IFNULL(rdt.description, 'TBA') AS day_description,
      IFNULL(tt.school_time_start, 'TBA') AS school_time_start,
      IFNULL(tt.school_time_end, 'TBA') AS school_time_end,
      IFNULL(rt.room_description, 'TBA') AS room_description,
      IFNULL(pft.fname, 'TBA') AS prof_firstname,
      IFNULL(pft.lname, 'TBA') AS prof_lastname
     FROM enrolled_subject AS es
    JOIN student_numbering_table AS snt ON es.student_number = snt.student_number
    JOIN person_table AS pt ON snt.person_id = pt.person_id
    JOIN course_table AS ct ON es.course_id = ct.course_id
    JOIN dprtmnt_section_table AS dst ON es.department_section_id = dst.id
    JOIN curriculum_table AS cct ON es.curriculum_id = cct.curriculum_id
    JOIN program_table AS pgt ON cct.program_id = pgt.program_id
    JOIN section_table AS st ON dst.section_id = st.id
    LEFT JOIN time_table AS tt
      ON tt.course_id = es.course_id
     AND tt.department_section_id = es.department_section_id
     AND tt.school_year_id = es.active_school_year_id
    LEFT JOIN room_day_table AS rdt ON tt.room_day = rdt.id
    LEFT JOIN room_table AS rt ON tt.department_room_id = rt.room_id
    LEFT JOIN prof_table AS pft ON tt.professor_id = pft.prof_id
    JOIN active_school_year_table AS sy ON es.active_school_year_id = sy.id
    WHERE pt.person_id = ? AND sy.astatus = 1;`,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }
    console.log(rows);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching person:", error);
    res.status(500).json({ error: "Database error" });
  }
});

//GET Grading Status Period
router.get("/grading_status", async (req, res) => {
  try {
    const [rows] = await db3.execute(
      "SELECT status FROM period_status WHERE description = 'Final Grading Period'",
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Grading period not found" });
    }

    res.json({ status: rows[0].status });
    console.log({ status: rows[0].status });
  } catch (err) {
    console.error("Error checking grading status:", err);
    res.status(500).json({ message: "Database error" });
  }
});

router.get("/student_grade/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [[studentInfo]] = await db3.execute(
      `
      SELECT
        snt.student_number,
        pt.last_name,
        pt.first_name,
        pt.middle_name
      FROM student_numbering_table AS snt
      JOIN person_table AS pt
        ON snt.person_id = pt.person_id
      WHERE pt.person_id = ?
      LIMIT 1
      `,
      [id],
    );

    if (!studentInfo) {
      return res.status(404).json({
        error: "Student not found",
      });
    }

    const [rows] = await db3.execute(
      `
      SELECT
        ct.course_description,
        ct.course_code,
        es.en_remarks,
        es.remarks,
        ct.course_unit,
        ct.lab_unit,
        ${GWA_UNIT_SQL} AS gwa_units,
        CASE WHEN ${GWA_EXCLUSION_SQL} THEN 1 ELSE 0 END AS is_gwa_excluded,

        cct.curriculum_id,
        pgt.program_code,
        pgt.program_description,

        st.description AS section_description,

        ylt.year_level_description,
        ylt.level_type,
        sst.year_level_id,

        smt.semester_description,
        smt.semester_id,
        yt.year_description,

        IFNULL(pft.fname, 'TBA') AS fname,
        IFNULL(pft.lname, 'TBA') AS lname,

        es.final_grade,

        gc_main.equivalent_grade AS numeric_grade,
        gc_main.descriptive_rating AS descriptive_grade,

        es.fe_status,
        es.is_posted,
        es.active_school_year_id,

        ? AS last_name,
        ? AS first_name,
        ? AS middle_name,
        ? AS student_number,

        CASE
          WHEN LOWER(IFNULL(es.remarks, '')) = 'migrated from old system'
          THEN 1
          ELSE 0
        END AS is_migrated,

        GROUP_CONCAT(
          DISTINCT CONCAT(
            IFNULL(rdt.description, ''), ' ',
            IFNULL(TIME_FORMAT(tt2.school_time_start, '%h:%i %p'), ''), '-',
            IFNULL(TIME_FORMAT(tt2.school_time_end, '%h:%i %p'), '')
          )
          ORDER BY rdt.description
          SEPARATOR '\n'
        ) AS schedule

      FROM enrolled_subject AS es

      JOIN student_status_table AS sst
        ON sst.student_number = es.student_number
        AND sst.active_school_year_id = es.active_school_year_id

      LEFT JOIN dprtmnt_section_table AS dst
        ON es.department_section_id = dst.id

      JOIN curriculum_table AS cct
        ON es.curriculum_id = cct.curriculum_id

      JOIN program_table AS pgt
        ON cct.program_id = pgt.program_id

      LEFT JOIN section_table AS st
        ON dst.section_id = st.id

      LEFT JOIN prof_table AS pft
        ON pft.prof_id = (
          SELECT tt.professor_id
          FROM time_table AS tt
          WHERE tt.course_id = es.course_id
            AND tt.department_section_id = es.department_section_id
            AND tt.school_year_id = es.active_school_year_id
            AND tt.professor_id IS NOT NULL
          ORDER BY tt.id ASC
          LIMIT 1
        )

      LEFT JOIN time_table AS tt2
        ON tt2.course_id = es.course_id
        AND tt2.department_section_id = es.department_section_id
        AND tt2.school_year_id = es.active_school_year_id

      LEFT JOIN room_day_table AS rdt
        ON rdt.id = tt2.room_day

      JOIN active_school_year_table AS sy
        ON es.active_school_year_id = sy.id

      JOIN year_table AS yt
        ON sy.year_id = yt.year_id

      JOIN semester_table AS smt
        ON sy.semester_id = smt.semester_id

      JOIN course_table AS ct
        ON es.course_id = ct.course_id

      -- FIXED: use the canonical grade_conversion match — must have real
      -- numeric bounds and a positive raw score, same condition Honors uses.
      -- Previously this joined on min_score/max_score alone, which could
      -- silently mismatch against text-coded grade_conversion rows and
      -- produced a numeric_grade the Honors GWA would never have produced.
      LEFT JOIN grade_conversion gc_main
        ON ${gwaGradeJoinSql("es", "gc_main")}

      LEFT JOIN program_tagging_table AS ptg
        ON ptg.curriculum_id = es.curriculum_id
        AND ptg.course_id = es.course_id

      LEFT JOIN year_level_table AS ylt
        ON sst.year_level_id = ylt.year_level_id

      WHERE es.student_number = ?

      GROUP BY
        es.id,
        ct.course_code,
        ct.course_description,
        es.en_remarks,
        es.remarks,
        ct.course_unit,
        ct.lab_unit,
        cct.curriculum_id,
        pgt.program_code,
        pgt.program_description,
        st.description,
        ylt.year_level_description,
        ylt.level_type,
        sst.year_level_id,
        smt.semester_description,
        smt.semester_id,
        yt.year_description,
        pft.fname,
        pft.lname,
        es.final_grade,
        gc_main.equivalent_grade,
        gc_main.descriptive_rating,
        es.fe_status,
        es.is_posted,
        es.active_school_year_id

      ORDER BY
        yt.year_description DESC,
        smt.semester_id DESC,
        sst.year_level_id DESC;
      `,
      [
        studentInfo.last_name,
        studentInfo.first_name,
        studentInfo.middle_name,
        studentInfo.student_number,
        studentInfo.student_number,
      ],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Schedule not found",
      });
    }

    const gwaByTerm = rows.reduce((acc, row) => {
      const grade = Number(row.numeric_grade);
      const units = Number(row.gwa_units);
      if (
        Number(row.is_gwa_excluded) === 1 ||
        !Number.isFinite(grade) ||
        grade <= 0 ||
        !Number.isFinite(units) ||
        units <= 0
      )
        return acc;

      const key = `${row.year_description}-${row.semester_id}`;
      if (!acc[key]) acc[key] = { total: 0, units: 0 };
      acc[key].total += grade * units;
      acc[key].units += units;
      return acc;
    }, {});

    rows.forEach((row) => {
      const key = `${row.year_description}-${row.semester_id}`;
      const term = gwaByTerm[key];
      row.gwa = term?.units ? term.total / term.units : null;
      row.honor_title = null;
    });

    res.json(rows);
  } catch (error) {
    console.error("Error fetching person:", error);
    res.status(500).json({
      error: "Database error",
    });
  }
});

router.get("/student/latin-honor-standing/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [[standing]] = await db3.query(
      `
      SELECT
        overall_gwa.student_number,
        overall_gwa.overall_gwa,
        overall_gwa.max_grade,
        overall_gwa.subject_count,
        hr.title AS latin_honor,
        gwa_rule.title AS gwa_rule_title
      FROM (
        SELECT
          es.student_number,
          ROUND(
            SUM(CAST(gc.equivalent_grade AS DECIMAL(10,4)) * ${GWA_UNIT_SQL})
            / NULLIF(SUM(${GWA_UNIT_SQL}), 0),
            4
          ) AS overall_gwa,
          MAX(CAST(gc.equivalent_grade AS DECIMAL(10,4))) AS max_grade,
          COUNT(es.id) AS subject_count
        FROM enrolled_subject es
        INNER JOIN student_numbering_table snt
          ON snt.student_number = es.student_number
          AND snt.person_id = ?
        INNER JOIN student_status_table ss
          ON ss.student_number = es.student_number
          AND ss.active_school_year_id = es.active_school_year_id
          AND ss.enrolled_status = '1'
        INNER JOIN course_table ct
          ON ct.course_id = es.course_id
          AND ct.is_latin = 1
        INNER JOIN grade_conversion gc
          ON gc.is_disqualified = 0
          AND gc.min_score IS NOT NULL
          AND gc.max_score IS NOT NULL
          AND CAST(es.final_grade AS DECIMAL(8,2)) > 0
          AND CAST(es.final_grade AS DECIMAL(8,2))
              BETWEEN gc.min_score AND gc.max_score
        WHERE es.en_remarks = 1
          AND ${GWA_UNIT_SQL} > 0
          AND NOT ${GWA_EXCLUSION_SQL}
        GROUP BY es.student_number
      ) overall_gwa
      LEFT JOIN honors_rules gwa_rule
        ON gwa_rule.category = 1
        AND overall_gwa.overall_gwa BETWEEN gwa_rule.min_gwa AND gwa_rule.max_gwa
      LEFT JOIN honors_rules hr
        ON hr.category = 1
        AND overall_gwa.overall_gwa BETWEEN hr.min_gwa AND hr.max_gwa
        AND overall_gwa.max_grade <= hr.max_subject_grade
      ORDER BY hr.min_gwa ASC
      LIMIT 1
      `,
      [id],
    );
    const [[disqualifiedGrade]] = await db3.query(
      `
      SELECT COUNT(es.id) AS count
      FROM enrolled_subject es
      INNER JOIN student_numbering_table snt
        ON snt.student_number = es.student_number
        AND snt.person_id = ?
      INNER JOIN student_status_table ss
        ON ss.student_number = es.student_number
        AND ss.active_school_year_id = es.active_school_year_id
        AND ss.enrolled_status = '1'
      INNER JOIN course_table ct
        ON ct.course_id = es.course_id
        AND ct.is_latin = 1
      INNER JOIN grade_conversion gc
        ON gc.is_disqualified = 1
        AND gc.min_score IS NOT NULL
        AND gc.max_score IS NOT NULL
        AND CAST(es.final_grade AS DECIMAL(8,2)) > 0
        AND CAST(es.final_grade AS DECIMAL(8,2))
            BETWEEN gc.min_score AND gc.max_score
      WHERE es.en_remarks = 1
        AND ${GWA_UNIT_SQL} > 0
        AND NOT ${GWA_EXCLUSION_SQL}
      `,
      [id],
    );

    if (Number(disqualifiedGrade?.count || 0) > 0) {
      return res.json({
        ...standing,
        standing: "disqualified",
        latin_honor: null,
      });
    }

    if (!standing) {
      return res.json({
        standing: "not_evaluated",
        latin_honor: null,
        overall_gwa: null,
        max_grade: null,
        subject_count: 0,
      });
    }

    res.json({
      ...standing,
      standing: standing.latin_honor
        ? "qualified"
        : standing.gwa_rule_title
          ? "disqualified"
          : "not_in_standing",
    });
  } catch (error) {
    console.error("Failed to fetch student Latin honor standing:", error);
    res.status(500).json({ error: "Failed to fetch Latin honor standing" });
  }
});

router.get("/student/view_latest_grades/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [courses] = await db3.execute(
      `
      SELECT DISTINCT
        ct.course_description,
        ct.course_code,
        es.en_remarks,
        es.remarks,
        ct.course_unit,
        ct.lab_unit,
        pgt.program_code,
        pgt.program_description,
        st.description AS section_description,
        pft.lname AS prof_lastname,
        IFNULL(pft.fname, 'TBA') AS fname,
        IFNULL(pft.lname, 'TBA') AS lname,
        rdt.description AS day_description,
        tt.school_time_start,
        tt.school_time_end,
        rt.room_description,
        yt.year_description AS first_year,
        yt.year_description + 1 AS last_year,
        smt.semester_description,
        es.final_grade,
        es.fe_status,
        es.en_remarks,
        CASE
          WHEN LOWER(IFNULL(es.remarks, '')) = 'migrated from old system' THEN 1
          ELSE 0
        END AS is_migrated
      FROM enrolled_subject AS es
        JOIN student_numbering_table AS snt ON es.student_number = snt.student_number
        JOIN person_table AS pt ON snt.person_id = pt.person_id
        JOIN course_table AS ct ON es.course_id = ct.course_id
        LEFT JOIN dprtmnt_section_table AS dst ON es.department_section_id = dst.id
        JOIN curriculum_table AS cct ON es.curriculum_id = cct.curriculum_id
        JOIN program_table AS pgt ON cct.program_id = pgt.program_id
        LEFT JOIN section_table AS st ON dst.section_id = st.id
        LEFT JOIN time_table AS tt
          ON tt.course_id = es.course_id
        AND tt.department_section_id = es.department_section_id
        LEFT JOIN room_day_table AS rdt ON tt.room_day = rdt.id
        LEFT JOIN room_table AS rt ON tt.department_room_id = rt.room_id
        LEFT JOIN prof_table AS pft ON tt.professor_id = pft.prof_id
        JOIN active_school_year_table AS sy ON es.active_school_year_id = sy.id
        JOIN year_table AS yt ON sy.year_id = yt.year_id
        JOIN semester_table AS smt ON sy.semester_id = smt.semester_id
      WHERE pt.person_id = ?
    `,
      [id],
    );

    res.json({ status: "ok", grades: courses });
  } catch (error) {
    console.error("Error fetching grades:", error);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/student_course/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db3.execute(
      `
      SELECT DISTINCT snt.student_number, pt.prof_id, cyt.year_description AS curriculum_year,cct.curriculum_id, sy.id AS active_school_year_id, ct.course_id, pt.fname, pt.mname, pt.lname, ct.course_description, ct.course_code, pt.fname, pt.mname, pt.lname, dt.dprtmnt_code AS department, ct.course_code,pgt.program_code, smt.semester_description, yrt.year_description AS current_year, yrt.year_description + 1 AS next_year FROM enrolled_subject AS es
        INNER JOIN student_numbering_table AS snt ON es.student_number = snt.student_number
        INNER JOIN person_table AS pst ON snt.person_id = pst.person_id
        INNER JOIN course_table AS ct ON es.course_id = ct.course_id
        INNER JOIN curriculum_table AS cct ON es.curriculum_id = cct.curriculum_id
        LEFT JOIN time_table AS tt
          ON tt.course_id = es.course_id
          AND tt.department_section_id = es.department_section_id
          AND tt.school_year_id = es.active_school_year_id
        LEFT JOIN prof_table AS pt ON tt.professor_id = pt.prof_id
        INNER JOIN active_school_year_table AS sy ON es.active_school_year_id = sy.id
        LEFT JOIN dprtmnt_curriculum_table AS dct ON es.curriculum_id = dct.curriculum_id
        LEFT JOIN dprtmnt_table AS dt ON dct.dprtmnt_id = dt.dprtmnt_id
        LEFT JOIN program_table AS pgt ON cct.program_id = pgt.program_id
        LEFT JOIN year_table AS yrt ON sy.year_id = yrt.year_id
        LEFT JOIN year_table AS cyt ON cct.year_id = cyt.year_id
        LEFT JOIN semester_table AS smt ON sy.semester_id = smt.semester_id
      WHERE pst.person_id = ?
        AND es.fe_status = 0
        AND (
          (
            sy.astatus = 1
            AND LOWER(IFNULL(es.remarks, '')) <> 'migrated from old system'
          )
          OR (
            LOWER(IFNULL(es.remarks, '')) = 'migrated from old system'
            AND es.active_school_year_id = (
              SELECT es2.active_school_year_id
              FROM enrolled_subject AS es2
                INNER JOIN active_school_year_table AS sy2 ON es2.active_school_year_id = sy2.id
                INNER JOIN year_table AS yrt2 ON sy2.year_id = yrt2.year_id
              WHERE es2.student_number = snt.student_number
                AND LOWER(IFNULL(es2.remarks, '')) = 'migrated from old system'
              ORDER BY yrt2.year_description DESC, sy2.semester_id DESC, sy2.id DESC
              LIMIT 1
            )
          )
        );
    `,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Professor Data are not found" });
    }

    res.json(rows);
  } catch (err) {
    console.error("Error checking grading status:", err);
    res.status(500).json({ message: "Database error" });
  }
});

router.post("/student_evaluation", async (req, res) => {
  const {
    student_number,
    school_year_id,
    prof_id,
    course_id,
    question_id,
    answer,
  } = req.body;

  try {
    await db3.execute(
      `
      INSERT INTO student_evaluation_table
      (student_number, school_year_id, prof_id, course_id, question_id, question_answer)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [student_number, school_year_id, prof_id, course_id, question_id, answer],
    );

    await db3.execute(
      `
      UPDATE enrolled_subject
      SET fe_status = 1
      WHERE student_number = ? AND course_id = ? AND active_school_year_id = ?
      `,
      [student_number, course_id, school_year_id],
    );

    res.status(200).send({ message: "Evaluation successfully recorded!" });
  } catch (err) {
    console.error("Database / Server Error:", err);
    res
      .status(500)
      .send({ message: "Database / Server Error", error: err.message });
  }
});

router.get("/student-dashboard/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const query = `SELECT snt.student_number, pt.* FROM student_numbering_table as snt
      INNER JOIN person_table as pt ON snt.person_id = pt.person_id
      WHERE snt.person_id = ?
    `;
    const [result] = await db3.query(query, [id]);
    console.log(result);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).send("DB ERROR");
  }
});

router.get("/student-data/:studentNumber", async (req, res) => {
  const studentNumber = req.params.studentNumber;

  const query = `
  SELECT
      sn.student_number,
      p.person_id,
      p.profile_img,
      p.lrnNumber,
      p.cellphoneNumber,
      p.last_name,
      p.middle_name,
      p.campus,
      p.first_name,
      p.extension,
      p.gender,
      p.age,
      p.emailAddress AS email,
      ss.active_curriculum AS curriculum,
      ss.year_level_id AS yearlevel,
      prog.program_description AS program,
      prog.program_code,
      d.dprtmnt_name AS college,
      es.active_school_year_id
  FROM student_numbering_table sn
  INNER JOIN person_table p ON sn.person_id = p.person_id
  INNER JOIN student_status_table ss ON ss.student_number = sn.student_number
  INNER JOIN curriculum_table c ON ss.active_curriculum = c.curriculum_id
  INNER JOIN program_table prog ON c.program_id = prog.program_id
  INNER JOIN dprtmnt_curriculum_table dc ON c.curriculum_id = dc.curriculum_id
  INNER JOIN year_table yt ON c.year_id = yt.year_id
  INNER JOIN dprtmnt_table d ON dc.dprtmnt_id = d.dprtmnt_id
  LEFT JOIN enrolled_subject es ON sn.student_number = es.student_number
  WHERE sn.student_number = ?;
`;

  try {
    const [results] = await db3.query(query, [studentNumber]);
    res.json(results[0] || {});
  } catch (err) {
    console.error("Failed to fetch student data:", err);
    res.status(500).json({ message: "Database error" });
  }
});

router.put("/student/update_person/:person_id", async (req, res) => {
  const { person_id } = req.params;
  const updatedData = req.body;

  try {
    const allowed = [
      "profile_img",
      "campus",
      "academicProgram",
      "classifiedAs",
      "applyingAs",
      "program",
      "program2",
      "program3",
      "yearLevel",
      "last_name",
      "first_name",
      "middle_name",
      "extension",
      "nickname",
      "height",
      "weight",
      "lrnNumber",
      "nolrnNumber",
      "gender",
      "pwdMember",
      "pwdType",
      "pwdId",
      "birthOfDate",
      "age",
      "birthPlace",
      "languageDialectSpoken",
      "citizenship",
      "religion",
      "spouse",
      "tribeEthnicGroup",
      "cellphoneNumber",
      "facebook_account",
      "emailAddress",
      "presentStreet",
      "presentBarangay",
      "presentZipCode",
      "presentRegion",
      "presentProvince",
      "presentMunicipality",
      "presentDswdHouseholdNumber",
      "sameAsPresentAddress",
      "permanentStreet",
      "permanentBarangay",
      "permanentZipCode",
      "permanentRegion",
      "permanentProvince",
      "permanentMunicipality",
      "permanentDswdHouseholdNumber",
      "solo_parent",
      "father_deceased",
      "father_family_name",
      "father_given_name",
      "father_middle_name",
      "father_ext",
      "father_nickname",
      "father_education",
      "father_education_level",
      "father_last_school",
      "father_course",
      "father_year_graduated",
      "father_school_address",
      "father_contact",
      "father_occupation",
      "father_employer",
      "father_income",
      "father_email",
      "mother_deceased",
      "mother_family_name",
      "mother_given_name",
      "mother_middle_name",
      "mother_ext",
      "mother_nickname",
      "mother_education",
      "mother_education_level",
      "mother_last_school",
      "mother_course",
      "mother_year_graduated",
      "mother_school_address",
      "mother_contact",
      "mother_occupation",
      "mother_employer",
      "mother_income",
      "mother_email",
      "guardian",
      "guardian_family_name",
      "guardian_given_name",
      "guardian_middle_name",
      "guardian_ext",
      "guardian_nickname",
      "guardian_address",
      "guardian_contact",
      "guardian_email",
      "annual_income",
      "has_no_siblings",
      "siblings",
      "schoolLevel",
      "schoolLastAttended",
      "schoolAddress",
      "courseProgram",
      "honor",
      "generalAverage",
      "yearGraduated",
      "schoolLevel1",
      "schoolLastAttended1",
      "schoolAddress1",
      "courseProgram1",
      "honor1",
      "generalAverage1",
      "yearGraduated1",
      "strand",
      "cough",
      "colds",
      "fever",
      "asthma",
      "faintingSpells",
      "heartDisease",
      "tuberculosis",
      "frequentHeadaches",
      "hernia",
      "chronicCough",
      "headNeckInjury",
      "hiv",
      "highBloodPressure",
      "diabetesMellitus",
      "allergies",
      "cancer",
      "smokingCigarette",
      "alcoholDrinking",
      "hospitalized",
      "hospitalizationDetails",
      "medications",
      "hadCovid",
      "covidDate",
      "vaccine1Brand",
      "vaccine1Date",
      "vaccine2Brand",
      "vaccine2Date",
      "booster1Brand",
      "booster1Date",
      "booster2Brand",
      "booster2Date",
      "chestXray",
      "cbc",
      "urinalysis",
      "otherworkups",
      "symptomsToday",
      "remarks",
      "termsOfAgreement",
      "created_at",
      "current_step",
    ];

    const cleanPayload = {};
    for (const key of Object.keys(updatedData)) {
      if (allowed.includes(key)) {
        cleanPayload[key] = updatedData[key];
      }
    }

    const nextEmailRaw = Object.prototype.hasOwnProperty.call(
      cleanPayload,
      "emailAddress",
    )
      ? cleanPayload.emailAddress
      : undefined;
    const nextEmail =
      nextEmailRaw === undefined || nextEmailRaw === null
        ? null
        : String(nextEmailRaw).trim().toLowerCase();

    const [result] = await db3.query(
      "UPDATE person_table SET ? WHERE person_id = ?",
      [cleanPayload, person_id],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "Person not found in ENROLLMENT DB" });
    }

    if (nextEmailRaw !== undefined) {
      if (!nextEmail) {
        return res
          .status(400)
          .json({ message: "emailAddress cannot be empty." });
      }

      const [conflicts] = await db3.query(
        `SELECT person_id
         FROM user_accounts
         WHERE LOWER(TRIM(email)) = ?
           AND person_id <> ?
         LIMIT 1`,
        [nextEmail, person_id],
      );
      if (conflicts.length > 0) {
        return res
          .status(409)
          .json({ message: "Email is already used by another account." });
      }

      await db3.query(
        `UPDATE user_accounts
         SET email = ?
         WHERE person_id = ? AND role = 'student'`,
        [nextEmail, person_id],
      );
    }

    res.json({
      success: true,
      message: "Student information updated successfully (DB3)",
    });
  } catch (err) {
    console.error("Error updating student (DB3):", err);
    res.status(500).json({ error: "Failed to update student record" });
  }
});

router.get("/student/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db3.execute(
      `
      SELECT DISTINCT
        snt.person_id,
        pt.profile_img AS profile_image,
        ua.role,
        pt.extension,
        pt.last_name,
        pt.first_name,
        pt.middle_name,
        snt.student_number,
        sst.year_level_id,
        ylt.year_level_description,
        es.curriculum_id,
        pgt.program_description,
        pgt.program_code,
        sy.id AS active_school_year_id,
        sy.semester_id
      FROM student_numbering_table AS snt
      INNER JOIN person_table AS pt ON snt.person_id = pt.person_id
      INNER JOIN user_accounts AS ua ON pt.person_id = ua.person_id
      INNER JOIN enrolled_subject AS es ON snt.student_number = es.student_number
      LEFT JOIN curriculum_table AS ct ON es.curriculum_id = ct.curriculum_id
      LEFT JOIN program_table AS pgt ON ct.program_id = pgt.program_id
      INNER JOIN student_status_table AS sst ON snt.student_number = sst.student_number
        AND sst.active_school_year_id = es.active_school_year_id
      LEFT JOIN year_level_table AS ylt ON ylt.year_level_id = sst.year_level_id
      INNER JOIN active_school_year_table AS sy ON es.active_school_year_id = sy.id
      WHERE pt.person_id = ?
      ORDER BY sy.astatus DESC, sy.year_id DESC, sy.semester_id DESC, sst.year_level_id DESC
      LIMIT 1
    `,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Person not found" });
    }

    const {
      student_number,
      year_level_id,
      curriculum_id,
      semester_id,
      active_school_year_id,
    } = rows[0];

    const regularCategoryClause = `
      LOWER(COALESCE(CAST(ptt.category AS CHAR), 'regular')) NOT IN ('bridging', 'bridge', 'special')
    `;

    const expectedRegularSubjectsQuery = `
      SELECT DISTINCT ptt.course_id
      FROM program_tagging_table AS ptt
      INNER JOIN year_level_table AS ylt ON ptt.year_level_id = ylt.year_level_id
      WHERE ptt.year_level_id = ?
        AND ptt.semester_id = ?
        AND ptt.curriculum_id = ?
        AND COALESCE(LOWER(ylt.level_type), 'year') <> 'special'
        AND ${regularCategoryClause}
    `;
    const [expectedRegularSubjects] = await db3.query(
      expectedRegularSubjectsQuery,
      [year_level_id, semester_id, curriculum_id],
    );

    const enrolledSubjectsQuery = `
      SELECT
        es.course_id,
        MAX(
          CASE
            WHEN LOWER(COALESCE(CAST(ptt.category AS CHAR), '')) IN ('bridging', 'bridge') THEN 1
            WHEN LOWER(COALESCE(ylt.year_level_description, '')) LIKE '%bridg%' THEN 1
            ELSE 0
          END
        ) AS is_bridging,
        MAX(
          CASE
            WHEN LOWER(COALESCE(CAST(ptt.category AS CHAR), '')) = 'special' THEN 1
            WHEN COALESCE(LOWER(ylt.level_type), 'year') = 'special' THEN 1
            ELSE 0
          END
        ) AS is_special
      FROM enrolled_subject AS es
      LEFT JOIN program_tagging_table AS ptt
        ON ptt.curriculum_id = es.curriculum_id
        AND ptt.course_id = es.course_id
        AND ptt.semester_id = ?
      LEFT JOIN year_level_table AS ylt ON ptt.year_level_id = ylt.year_level_id
      WHERE es.student_number = ?
        AND es.active_school_year_id = ?
      GROUP BY es.course_id
    `;
    const [enrolledSubjects] = await db3.query(enrolledSubjectsQuery, [
      semester_id,
      student_number,
      active_school_year_id,
    ]);

    const [officialRegularityRows] = await db3.query(
      `
      SELECT
        CASE
          WHEN COUNT(es.is_regular) = 0 THEN NULL
          WHEN MIN(es.is_regular) = 0 THEN 0
          ELSE 1
        END AS official_is_regular
      FROM enrolled_subject AS es
      WHERE es.student_number = ?
        AND es.active_school_year_id = ?
      `,
      [student_number, active_school_year_id],
    );

    const expectedRegularCourseIds = new Set(
      expectedRegularSubjects.map((subject) => Number(subject.course_id)),
    );
    const enrolledRegularCourseIds = new Set(
      enrolledSubjects
        .filter(
          (subject) =>
            Number(subject.is_bridging) !== 1 &&
            Number(subject.is_special) !== 1,
        )
        .map((subject) => Number(subject.course_id)),
    );

    const missingRegularSubjects = [...expectedRegularCourseIds].filter(
      (courseId) => !enrolledRegularCourseIds.has(courseId),
    );
    const extraRegularSubjects = [...enrolledRegularCourseIds].filter(
      (courseId) => !expectedRegularCourseIds.has(courseId),
    );

    const computedStudentStatus =
      missingRegularSubjects.length === 0 && extraRegularSubjects.length === 0
        ? "Regular"
        : "Irregular";
    const officialIsRegular = officialRegularityRows[0]?.official_is_regular;
    const student_status =
      officialIsRegular === null || officialIsRegular === undefined
        ? computedStudentStatus
        : Number(officialIsRegular) === 1
          ? "Regular"
          : "Irregular";
    const regularity_source =
      officialIsRegular === null || officialIsRegular === undefined
        ? "computed"
        : "official";

    const has_bridging = enrolledSubjects.some(
      (subject) => Number(subject.is_bridging) === 1,
    );
    const has_special = enrolledSubjects.some(
      (subject) => Number(subject.is_special) === 1,
    );
    const subject_load_note =
      has_bridging && has_special
        ? "With Bridging and Special"
        : has_bridging
          ? "With Bridging"
          : has_special
            ? "With Special"
            : "Normal";
    const display_status =
      subject_load_note === "Normal"
        ? student_status
        : `${student_status} ${subject_load_note}`;

    return res.json({
      ...rows[0],
      student_status,
      display_status,
      subject_load_note,
      computed_student_status: computedStudentStatus,
      regularity_source,
      has_bridging,
      has_special,
      missing_regular_subject_count: missingRegularSubjects.length,
      extra_regular_subject_count: extraRegularSubjects.length,
    });
  } catch (error) {
    console.error("Error fetching person:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

router.put("/uploads/student/remarks/:upload_id", async (req, res) => {
  const { upload_id } = req.params;
  const { status, remarks, document_status, user_id } = req.body;

  try {
    await db3.query(
      `UPDATE requirement_uploads
       SET status = ?, remarks = ?, document_status = ?, last_updated_by = ?
       WHERE upload_id = ?`,
      [status, remarks || null, document_status || null, user_id, upload_id],
    );

    res.json({ message: "Document status updated successfully." });
  } catch (err) {
    console.error("Error updating document status:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.get("/person/student/:storedID", async (req, res) => {
  const id = req.params.storedID;

  try {
    const [personRows] = await db3.query(
      `SELECT emailAddress FROM person_table WHERE person_id = ? `,
      [id],
    );

    const personEmail = personRows[0].emailAddress;

    const sql = `
      SELECT p.*, a.applicant_number
      FROM person_table p
      LEFT JOIN applicant_numbering_table a
      ON p.person_id = a.person_id
      WHERE p.emailAddress = ?
    `;

    const [rows] = await db.query(sql, [personEmail]);
    console.log("Person Data: ", rows);

    res.status(200).json({
      message: "Successfully  etch student record from admission",
      rows,
    });
  } catch (err) {
    console.error("Error fetching registrar count:", error);
    res
      .status(500)
      .json({ message: "Server error while fetching registrar count" });
  }
});

router.get("/get_students_grouped", async (req, res) => {
  try {
    const [rows] = await db3.query(`
 SELECT DISTINCT
snt.student_number,
pt.first_name,
pt.middle_name,
pt.last_name,
dt.dprtmnt_code,
dt.dprtmnt_name,
pgt.program_code,
pgt.program_description,
pgt.major,
ylt.year_level_description
FROM enrolled_subject es
JOIN student_status_table sst ON es.student_number = sst.student_number
JOIN student_numbering_table snt ON sst.student_number = snt.student_number
JOIN person_table pt ON snt.person_id = pt.person_id
JOIN dprtmnt_curriculum_table dct ON es.curriculum_id = dct.curriculum_id
JOIN curriculum_table cct ON dct.curriculum_id = cct.curriculum_id
JOIN dprtmnt_table dt ON dct.dprtmnt_id = dt.dprtmnt_id
JOIN program_table pgt ON cct.program_id = pgt.program_id
JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
ORDER BY dt.dprtmnt_code, pgt.program_code, pt.last_name;

    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed fetching students" });
  }
});

router.get("/student_enrollment", async (req, res) => {
  const employee_id =
    req.query.employee_id ||
    req.headers["x-employee-id"] ||
    req.headers["x-audit-actor-id"];
  const q = String(req.query.q || req.query.search || "").trim();
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

  try {
    // Search mode: require at least 2 characters and return a small page.
    // Avoids dumping the full enrollment directory into the browser.
    if (q.length < 2) {
      return res.json([]);
    }

    if (employee_id) {
      const scope = await getRegistrarScope(employee_id);
      if (scope.length === 0) {
        return res.json([]);
      }
    }

    const like = `%${q}%`;
    const scopeJoinSql = employee_id
      ? `
        INNER JOIN (
          SELECT
            ranked.student_number,
            ranked.dprtmnt_id,
            ranked.program_id
          FROM (
            SELECT
              es.student_number,
              dct.dprtmnt_id,
              cct.program_id,
              ROW_NUMBER() OVER (
                PARTITION BY es.student_number
                ORDER BY sy.year_id DESC, sy.semester_id DESC, es.id DESC
              ) AS rn
            FROM enrolled_subject es
            INNER JOIN active_school_year_table sy ON sy.id = es.active_school_year_id
            INNER JOIN curriculum_table cct ON cct.curriculum_id = es.curriculum_id
            INNER JOIN dprtmnt_curriculum_table dct ON dct.curriculum_id = cct.curriculum_id
            INNER JOIN registrar_scope_table rst
              ON rst.employee_id = ?
              AND rst.dprtmnt_id = dct.dprtmnt_id
              AND rst.program_id = cct.program_id
          ) ranked
          WHERE ranked.rn = 1
        ) cur ON cur.student_number = snt.student_number
      `
      : "";
    const params = employee_id
      ? [employee_id, like, like, like, like, like, limit]
      : [like, like, like, like, like, limit];

    const [rows] = await db3.query(
      `
        SELECT DISTINCT
          snt.student_number,
          pt.first_name,
          pt.middle_name,
          pt.last_name
        FROM student_numbering_table snt
        LEFT JOIN person_table pt ON snt.person_id = pt.person_id
        ${scopeJoinSql}
        WHERE (
          CAST(snt.student_number AS CHAR) LIKE ?
          OR pt.first_name LIKE ?
          OR pt.middle_name LIKE ?
          OR pt.last_name LIKE ?
          OR CONCAT_WS(' ', pt.first_name, pt.middle_name, pt.last_name) LIKE ?
        )
        ORDER BY snt.student_number ASC
        LIMIT ?
      `,
      params,
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed fetching students" });
  }
});
router.get("/student-info-for-enrollment/:student_number", async (req, res) => {
  const { student_number } = req.params;

  try {
    const [rows] = await db3.query(
      `
        SELECT
          es.id,
          cct.curriculum_id,
          sy.id as active_school_year_id, 
          pgt.program_description, 
          yrt_cur.year_description, 
          yrt_sy.year_description AS current_year, 
          smt.semester_description,
          snt.student_number,
          IFNULL(es.final_grade, "-") as final_grade,
          es.grades_status,
          IFNULL(es.en_remarks, 0) as en_remarks,
          ylt.year_level_description, 
          cst.course_id,
		      cst.course_code,
          cst.course_description,
          cst.course_unit,
          es.remarks,
          sst.id AS student_status_id
        FROM enrolled_subject es
          INNER JOIN student_numbering_table snt ON es.student_number = snt.student_number
          INNER JOIN student_status_table sst ON snt.student_number = sst.student_number
            AND es.active_school_year_id = sst.active_school_year_id
          INNER JOIN curriculum_table cct ON es.curriculum_id = cct.curriculum_id
          INNER JOIN program_table pgt ON cct.program_id = pgt.program_id
          INNER JOIN active_school_year_table sy ON es.active_school_year_id = sy.id
          INNER JOIN year_table yrt_cur ON cct.year_id = yrt_cur.year_id
          INNER JOIN year_table yrt_sy ON sy.year_id = yrt_sy.year_id
          INNER JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id 
          INNER JOIN semester_table smt ON sy.semester_id = smt.semester_id
          INNER JOIN course_table cst ON es.course_id = cst.course_id
          WHERE es.student_number = ? AND en_remarks = 0
      `,
      [student_number],
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: "student record is not found" });
    }

    res.json(rows);
  } catch (err) {
    console.error("Failed to get student record:", err);
    res.status(500).send("Failed to get student record.");
  }
});

router.get("/student_enrollment/:student_number", async (req, res) => {
  const { student_number } = req.params;

  try {
    const [rows] = await db3.query(
      `
        SELECT DISTINCT
          snt.student_number,
          pt.first_name,
          pt.middle_name,
          pt.last_name,
          pt.presentStreet,
          pt.presentBarangay,
          pt.presentZipCode,
          pt.presentRegion,
          pt.presentProvince,
          pt.presentMunicipality,
          pt.presentDswdHouseholdNumber,
          pt.emailAddress,
          pt.cellphoneNumber,
          pt.campus,
          dt.dprtmnt_id,
          dt.dprtmnt_code,
          dt.dprtmnt_name,
          cct.curriculum_id,
          pgt.program_code,
          pgt.program_description,
          sst.year_level_id,
          ylt.year_level_description,
          sy.id AS active_school_year_id,
          es.is_regular,
          smt.semester_description,
          st.description AS section_description,
          CONCAT(yt.year_description, '-', yt.year_description + 1) AS current_academic_year
        FROM student_numbering_table snt  
        LEFT JOIN enrolled_subject es ON snt.student_number = es.student_number
        LEFT JOIN person_table pt ON snt.person_id = pt.person_id
        LEFT JOIN student_status_table sst
          ON snt.student_number = sst.student_number
          AND sst.active_school_year_id = es.active_school_year_id
        LEFT JOIN dprtmnt_curriculum_table dct ON pt.program = dct.curriculum_id
        LEFT JOIN curriculum_table cct ON dct.curriculum_id = cct.curriculum_id
        LEFT JOIN dprtmnt_table dt ON dct.dprtmnt_id = dt.dprtmnt_id
        LEFT JOIN program_table pgt ON cct.program_id = pgt.program_id
        LEFT JOIN dprtmnt_section_table dst ON es.department_section_id = dst.id
        LEFT JOIN section_table st ON dst.section_id = st.id
        LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
        LEFT JOIN active_school_year_table sy ON es.active_school_year_id = sy.id
        LEFT JOIN semester_table smt ON sy.semester_id = smt.semester_id
        LEFT JOIN year_table yt ON sy.year_id = yt.year_id
        WHERE snt.student_number = ?
        ORDER BY
          yt.year_description DESC,
          sy.semester_id DESC,
          sst.year_level_id DESC,
          es.id DESC
        LIMIT 1
      `,
      [student_number],
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed fetching students" });
  }
});

router.put("/student-enrollment/status", async (req, res) => {
  const { student_number, active_school_year_id, is_regular } = req.body;

  if (
    !student_number ||
    !active_school_year_id ||
    ![0, 1].includes(Number(is_regular))
  ) {
    return res.status(400).json({
      success: false,
      message:
        "student_number, active_school_year_id, and is_regular are required",
    });
  }

  try {
    const [result] = await db3.query(
      `UPDATE enrolled_subject
       SET is_regular = ?
       WHERE student_number = ? AND active_school_year_id = ?`,
      [Number(is_regular), student_number, active_school_year_id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "No enrolled subjects found for this student and school year",
      });
    }

    res.json({
      success: true,
      message: `Student status changed to ${Number(is_regular) === 1 ? "Regular" : "Irregular"}`,
      affectedRows: result.affectedRows,
    });
  } catch (err) {
    console.error("Failed to change student enrollment status:", err);
    res.status(500).json({
      success: false,
      message: "Failed to change student enrollment status",
    });
  }
});

router.get("/student/:person_id/curriculum-subjects", async (req, res) => {
  try {
    const { person_id } = req.params;

    const [rows] = await db3.query(
      `
  SELECT DISTINCT
    pt.person_id,
    snt.student_number,
    pt.first_name,
    pt.last_name,
    pt.middle_name,

    base_es.curriculum_id,
    p.program_code,
    p.program_description,
    y.year_description,

    ptg.year_level_id,
    yl.year_level_description,
    ptg.semester_id,
    s.semester_description,

    co.course_id,
    co.course_code,
    co.course_description,
    co.lec_unit,
    co.lab_unit,
    co.course_unit,

    ptg.lec_fee,
    ptg.lab_fee,
    ptg.amount,

    IFNULL(prf.fname, 'TBA') AS fname,
    IFNULL(prf.lname, 'TBA') AS lname,
    sec.description AS section_description,
    GROUP_CONCAT(
      DISTINCT CONCAT(
        IFNULL(rdt.description, ''), ' ',
        IFNULL(TIME_FORMAT(tt.school_time_start, '%h:%i %p'), ''), '-',
        IFNULL(TIME_FORMAT(tt.school_time_end, '%h:%i %p'), '')
      )
      ORDER BY rdt.description
      SEPARATOR '\n'
    ) AS schedule

  FROM person_table pt
  JOIN student_numbering_table snt ON pt.person_id = snt.person_id

  JOIN enrolled_subject base_es ON base_es.student_number = snt.student_number

  JOIN curriculum_table ct ON ct.curriculum_id = base_es.curriculum_id
  JOIN program_table p ON p.program_id = ct.program_id
  JOIN year_table y ON y.year_id = ct.year_id

  JOIN program_tagging_table ptg ON ptg.curriculum_id = base_es.curriculum_id
  JOIN course_table co ON co.course_id = ptg.course_id
  JOIN year_level_table yl ON yl.year_level_id = ptg.year_level_id
  JOIN semester_table s ON s.semester_id = ptg.semester_id

  LEFT JOIN enrolled_subject es
    ON es.student_number = snt.student_number
    AND es.course_id = co.course_id
    AND es.curriculum_id = base_es.curriculum_id

  LEFT JOIN dprtmnt_section_table dst ON es.department_section_id = dst.id
  LEFT JOIN section_table sec ON dst.section_id = sec.id

  LEFT JOIN time_table tt
    ON tt.course_id = co.course_id
    AND tt.department_section_id = es.department_section_id
    AND tt.school_year_id = es.active_school_year_id
  LEFT JOIN room_day_table rdt ON tt.room_day = rdt.id
  LEFT JOIN prof_table prf ON prf.prof_id = tt.professor_id

  WHERE pt.person_id = ?
  GROUP BY
    base_es.curriculum_id,
    co.course_id,
    ptg.year_level_id,
    ptg.semester_id,
    sec.description,
    prf.fname,
    prf.lname
  ORDER BY ptg.year_level_id, ptg.semester_id, co.course_code;
`,
      [person_id],
    );

    res.json(rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({ error: "Failed to fetch curriculum subjects" });
  }
});

router.get("/student-documents/:studentNumber", async (req, res) => {
  const { studentNumber } = req.params;
  console.log("studentNumber: ", studentNumber);

  try {
    console.log("Fetching documents for:", studentNumber);

    const [rows] = await db3.execute(
      `
    SELECT 
  snt.student_number,

  pt.person_id,
  pt.first_name,
  pt.middle_name,
  pt.last_name,
  pt.applyingAs,
  pt.profile_img,
  pt.emailAddress,

  rt.id AS requirements_id,
  rt.description,
  rt.category,
  rt.is_optional,

  ru.upload_id,
  ru.original_name,
  ru.file_path,
  ru.remarks,
  ru.status,
  ru.document_status,
  ru.missing_documents,
  ru.registrar_status,
  ru.created_at

FROM student_numbering_table snt

INNER JOIN person_table pt
  ON snt.person_id = pt.person_id

INNER JOIN requirements_table rt
  ON pt.applyingAs = rt.applicant_type 
  OR rt.applicant_type = 0

LEFT JOIN requirement_uploads ru
  ON ru.person_id = pt.person_id 
  AND ru.requirements_id = rt.id

WHERE snt.person_id = ?

ORDER BY rt.category, rt.description;
      `,
      [studentNumber],
    );

    console.log(rows);

    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

router.post("/upload/enrollment", upload.single("file"), async (req, res) => {
  const { requirements_id, person_id, remarks } = req.body;

  if (!requirements_id || !person_id || !req.file) {
    return res.status(400).json({ error: "Missing required fields or file" });
  }

  try {
    const [[studentInfo]] = await db3.query(
      `
      SELECT snt.student_number, pt.last_name, pt.first_name, pt.middle_name
      FROM student_numbering_table snt
      JOIN person_table pt ON snt.person_id = pt.person_id
      WHERE snt.person_id = ?
      `,
      [person_id],
    );

    const student_number = studentInfo?.student_number || "Unknown";

    const [descRows] = await db3.query(
      "SELECT description, short_label FROM requirements_table WHERE id = ?",
      [requirements_id],
    );

    if (!descRows.length) {
      return res.status(404).json({ message: "Requirement not found" });
    }

    const { short_label } = descRows[0];

    const year = new Date().getFullYear();
    const ext = path.extname(req.file.originalname).toLowerCase();

    const filename = `${student_number}_${short_label}_${year}${ext}`;

    const uploadDir = path.join(
      __dirname,
      "..",
      "..",
      "uploads",
      "StudentOnlineDocuments",
    );

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const finalPath = path.join(uploadDir, filename);

    const [existingFiles] = await db3.query(
      `SELECT upload_id, file_path FROM requirement_uploads
       WHERE person_id = ? AND requirements_id = ?`,
      [person_id, requirements_id],
    );

    for (const file of existingFiles) {
      const oldPath = path.join(
        __dirname,
        "..",
        "..",
        "uploads",
        "StudentOnlineDocuments",
        file.file_path,
      );

      try {
        await fs.promises.unlink(oldPath);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.warn("Delete warning:", err.message);
        }
      }

      await db3.query("DELETE FROM requirement_uploads WHERE upload_id = ?", [
        file.upload_id,
      ]);
    }

    await fs.promises.writeFile(finalPath, req.file.buffer);

    await db3.query(
      `INSERT INTO requirement_uploads
        (requirements_id, person_id, file_path, original_name, status, remarks)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [
        requirements_id,
        person_id,
        filename,
        req.file.originalname,
        remarks || null,
      ],
    );

    res.status(201).json({ message: "Enrollment upload successful" });
  } catch (err) {
    console.error("Enrollment upload error:", err);
    res.status(500).json({
      error: "Failed to upload",
      details: err.message,
    });
  }
});

router.delete("/student-upload/:uploadId", async (req, res) => {
  const { uploadId } = req.params;

  try {
    const [rows] = await db3.query(
      "SELECT file_path, person_id FROM requirement_uploads WHERE upload_id = ?",
      [uploadId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "File not found" });
    }

    const { filePath, person_id } = rows[0];

    const fullPath = path.join(
      __dirname,
      "..",
      "..",
      "uploads",
      "StudentOnlineDocuments",
      rows[0].file_path,
    );

    try {
      await fs.promises.unlink(fullPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("File delete warning:", err.message);
      }
    }

    await db3.query("DELETE FROM requirement_uploads WHERE upload_id = ?", [
      uploadId,
    ]);

    await db3.query(
      "UPDATE person_status_table SET requirements = 0 WHERE person_id = ?",
      [rows[0].person_id],
    );

    res.status(200).json({
      success: true,
      message: "Student file deleted successfully",
    });
  } catch (err) {
    console.error("Student delete error:", err);
    res.status(500).json({
      success: false,
      message: "Delete failed",
      error: err.message,
    });
  }
});

router.get("/student-status/:person_id", async (req, res) => {
  const { person_id } = req.params;
  try {
    const [[row]] = await db3.query(
      "SELECT requirements FROM person_status_table WHERE person_id = ?",
      [person_id],
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ requirements: row.requirements });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

router.post("/student-submit-requirements", async (req, res) => {
  const { person_id } = req.body;
  if (!person_id) return res.status(400).json({ error: "Missing person_id" });
  try {
    const [result] = await db3.query(
      "UPDATE person_status_table SET requirements = 1 WHERE person_id = ?",
      [person_id],
    );
    if (result.affectedRows === 0)
      return res
        .status(404)
        .json({ error: "Applicant status record not found" });
    res.json({ message: "Requirements submitted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update requirements status" });
  }
});

router.get("/department_by_curriculum/:curriculum_id", async (req, res) => {
  const { curriculum_id } = req.params;
  try {
    const [[row]] = await db3.query(
      `SELECT dt.dprtmnt_id, dt.dprtmnt_name, dt.dprtmnt_code
       FROM dprtmnt_curriculum_table dct
       JOIN dprtmnt_table dt ON dct.dprtmnt_id = dt.dprtmnt_id
       WHERE dct.curriculum_id = ?
       LIMIT 1`,
      [curriculum_id],
    );
    if (!row)
      return res
        .status(404)
        .json({ error: "No department mapped to this curriculum_id" });
    res.json(row);
  } catch (err) {
    console.error("[department_by_curriculum GET]", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/student/latin-honor-standing/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [[standing]] = await db3.query(
      `
      SELECT
        overall_gwa.student_number,
        overall_gwa.overall_gwa,
        overall_gwa.max_grade,
        overall_gwa.subject_count,
        hr.title AS latin_honor,
        gwa_rule.title AS gwa_rule_title
      FROM (
        SELECT
          es.student_number,
          ROUND(
            SUM(CAST(gc.equivalent_grade AS DECIMAL(10,4)) * ${GWA_UNIT_SQL})
            / NULLIF(SUM(${GWA_UNIT_SQL}), 0),
            4
          ) AS overall_gwa,
          MAX(CAST(gc.equivalent_grade AS DECIMAL(10,4))) AS max_grade,
          COUNT(es.id) AS subject_count
        FROM enrolled_subject es
        INNER JOIN student_numbering_table snt
          ON snt.student_number = es.student_number
          AND snt.person_id = ?
        INNER JOIN student_status_table ss
          ON ss.student_number = es.student_number
          AND ss.active_school_year_id = es.active_school_year_id
          AND ss.enrolled_status = '1'
        INNER JOIN course_table ct
          ON ct.course_id = es.course_id
          AND ct.is_latin = 1
        INNER JOIN grade_conversion gc
          ON ${gwaGradeJoinSql("es", "gc")}
        WHERE es.en_remarks = 1
          AND ${GWA_UNIT_SQL} > 0
          AND NOT ${GWA_EXCLUSION_SQL}
        GROUP BY es.student_number
      ) overall_gwa
      LEFT JOIN honors_rules gwa_rule
        ON gwa_rule.category = 1
        AND overall_gwa.overall_gwa BETWEEN gwa_rule.min_gwa AND gwa_rule.max_gwa
      LEFT JOIN honors_rules hr
        ON hr.category = 1
        AND overall_gwa.overall_gwa BETWEEN hr.min_gwa AND hr.max_gwa
        AND overall_gwa.max_grade <= hr.max_subject_grade
      ORDER BY hr.min_gwa ASC
      LIMIT 1
      `,
      [id],
    );

    const [[disqualifiedGrade]] = await db3.query(
      `
      SELECT COUNT(es.id) AS count
      FROM enrolled_subject es
      INNER JOIN student_numbering_table snt
        ON snt.student_number = es.student_number
        AND snt.person_id = ?
      INNER JOIN student_status_table ss
        ON ss.student_number = es.student_number
        AND ss.active_school_year_id = es.active_school_year_id
        AND ss.enrolled_status = '1'
      INNER JOIN course_table ct
        ON ct.course_id = es.course_id
        AND ct.is_latin = 1
      INNER JOIN grade_conversion gc
        ON gc.is_disqualified = 1
        AND gc.min_score IS NOT NULL
        AND gc.max_score IS NOT NULL
        AND CAST(es.final_grade AS DECIMAL(8,2)) > 0
        AND CAST(es.final_grade AS DECIMAL(8,2))
            BETWEEN gc.min_score AND gc.max_score
      WHERE es.en_remarks = 1
        AND ${GWA_UNIT_SQL} > 0
        AND NOT ${GWA_EXCLUSION_SQL}
      `,
      [id],
    );

    if (Number(disqualifiedGrade?.count || 0) > 0) {
      return res.json({
        ...standing,
        standing: "disqualified",
        latin_honor: null,
      });
    }

    if (!standing) {
      return res.json({
        standing: "not_evaluated",
        latin_honor: null,
        overall_gwa: null,
        max_grade: null,
        subject_count: 0,
      });
    }

    res.json({
      ...standing,
      standing: standing.latin_honor
        ? "qualified"
        : standing.gwa_rule_title
          ? "disqualified"
          : "not_in_standing",
    });
  } catch (error) {
    console.error("Failed to fetch student Latin honor standing:", error);
    res.status(500).json({ error: "Failed to fetch Latin honor standing" });
  }
});

router.get("/student-qr-information/:student_number", async (req, res) => {
  const studentNumber = String(req.params.student_number || "").trim();
  if (!studentNumber) {
    return res.status(400).json({ success: false, message: "Student number is required." });
  }

  try {
    // 1) Student must exist
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

    // 2) Portal accounts are optional for QR verification.
    // A student may already have a valid student record/COR before a portal
    // account is created, so do not reject the QR lookup when the account is
    // missing. Keep the account status when available for display/auditing.
    const [accountRows] = await db3.query(
      `SELECT id, status FROM user_accounts WHERE person_id = ? AND role = 'student' LIMIT 1`,
      [student.person_id],
    );

    // 3) Program/curriculum for display (latest enrollment record on file, regardless of term)
    // ✅ FIXED — now also pulls pgt.academic_program so Undergrad/Graduate/TechVoc
    // can be resolved into a label below, same as the TOR QR route already does.
    const [curriculumRows] = await db3.query(
      `
      SELECT pgt.program_code, pgt.program_description, pgt.major, pgt.academic_program, es.curriculum_id
      FROM enrolled_subject es
      LEFT JOIN curriculum_table ct ON ct.curriculum_id = es.curriculum_id
      LEFT JOIN program_table pgt ON pgt.program_id = ct.program_id
      WHERE es.student_number = ?
      ORDER BY es.id DESC
      LIMIT 1
      `,
      [studentNumber],
    );

    // ✅ NEW — attach the resolved academic_program_label the same way
    // evaluateGraduationEligibility() and /tor-qr-information do, so the
    // frontend's getAcademicProgramMeta() has something to read.
    const program = curriculumRows[0]
      ? {
          ...curriculumRows[0],
          academic_program_label:
            ACADEMIC_PROGRAM_LABELS[curriculumRows[0].academic_program] ?? "Unknown",
        }
      : null;

    // 4) Active school year — resolves AY + semester labels
    // (e.g. "AY 2026-2027" / "1st Semester") instead of just the raw
    // active_school_year_id, by joining year_table + semester_table.
    const [[activeYear]] = await db3.query(
      `SELECT
         asy.id AS active_school_year_id,
         asy.year_id,
         asy.semester_id,
         yt.year_description,
         smt.semester_description,
         smt.ordinal_label
       FROM active_school_year_table AS asy
       LEFT JOIN year_table AS yt ON yt.year_id = asy.year_id
       LEFT JOIN semester_table AS smt ON smt.semester_id = asy.semester_id
       WHERE asy.astatus = 1
       LIMIT 1`,
    );

    // Build display-ready labels from the raw year/semester data above.
    // year_description is stored as the starting year (e.g. 2026), so the
    // school year label is constructed as "AY {year}-{year + 1}".
    const schoolYearLabel = activeYear?.year_description
      ? `AY ${activeYear.year_description}-${Number(activeYear.year_description) + 1}`
      : null;
    const semesterLabel =
      activeYear?.ordinal_label || activeYear?.semester_description || null;

    let enrolledStatus = 0; // default: NOT enrolled unless proven otherwise
    let yearLevelDescription = null;
    let sectionDescription = null;
    let ongoingSubjects = [];

    if (activeYear) {
      // Definitive enrolled/not-enrolled check for the active term.
      // CROSS JOIN + LEFT JOIN guarantees a row even if the student has
      // no student_status_table record yet for this term (defaults to 0).
      const [[statusRow]] = await db3.query(
        `
        SELECT
          COALESCE(sst.enrolled_status, 0) AS enrolled_status,
          ylt.year_level_description
        FROM student_numbering_table AS snt
        CROSS JOIN active_school_year_table AS asy
        LEFT JOIN student_status_table AS sst
          ON sst.student_number = snt.student_number
         AND sst.active_school_year_id = asy.id
        LEFT JOIN year_level_table AS ylt
          ON sst.year_level_id = ylt.year_level_id
        WHERE snt.student_number = ?
          AND asy.astatus = 1
        LIMIT 1
        `,
        [studentNumber],
      );

      enrolledStatus = Number(statusRow?.enrolled_status || 0);
      yearLevelDescription = statusRow?.year_level_description || null;

      // Only pull ongoing subjects if actually enrolled this term —
      // otherwise a student with leftover rows from a prior partial
      // enrollment attempt would misleadingly show a class list.
      if (enrolledStatus === 1) {
        const [subjectRows] = await db3.query(
          `
          SELECT
            es.id,
            ct.course_code,
            ct.course_description,
            ct.course_unit,
            ct.lab_unit,
            st.description AS section_description,
            rdt.description AS day_description,
            tt.school_time_start,
            tt.school_time_end,
            rt.room_description,
            pft.fname AS prof_fname,
            pft.mname AS prof_mname,
            pft.lname AS prof_lname
          FROM enrolled_subject es
          INNER JOIN course_table ct ON es.course_id = ct.course_id
          LEFT JOIN dprtmnt_section_table dst ON es.department_section_id = dst.id
          LEFT JOIN section_table st ON dst.section_id = st.id
          LEFT JOIN time_table tt
            ON tt.course_id = es.course_id
            AND tt.department_section_id = es.department_section_id
            AND tt.school_year_id = es.active_school_year_id
          LEFT JOIN room_day_table rdt ON tt.room_day = rdt.id
          LEFT JOIN room_table rt ON tt.department_room_id = rt.room_id
          LEFT JOIN prof_table pft ON tt.professor_id = pft.prof_id
          WHERE es.student_number = ?
            AND es.active_school_year_id = ?
          ORDER BY ct.course_code ASC
          `,
          [studentNumber, activeYear.active_school_year_id],
        );

        ongoingSubjects = subjectRows.map((s) => ({
          course_code: s.course_code,
          course_description: s.course_description,
          units: (Number(s.course_unit) || 0) + (Number(s.lab_unit) || 0),
          section: s.section_description,
          schedule: s.day_description
            ? `${s.day_description} ${s.school_time_start || ""}-${s.school_time_end || ""}`.trim()
            : null,
          room: s.room_description,
          instructor: [s.prof_lname, s.prof_fname].filter(Boolean).join(", ") || null,
        }));

        sectionDescription = subjectRows[0]?.section_description || null;
      }
    }

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
      program, // ✅ now includes academic_program + academic_program_label
      account_status: accountRows[0]?.status || null,
      active_school_year: activeYear || null,
      school_year_label: schoolYearLabel,
      semester_label: semesterLabel,
      enrolled_status: enrolledStatus,
      year_level: yearLevelDescription,
      section: sectionDescription,
      subjects: ongoingSubjects,
      // this file is already written by /send_student_password_reminder + assign-student-number
      qr_image_url: `/uploads/StudentQRCodeGenerated/${studentNumber}_qrcode.png`,
    });
  } catch (error) {
    console.error("Student QR information lookup failed:", error);
    return res.status(500).json({ success: false, message: "Unable to load student information right now." });
  }
});

module.exports = router;
