const express = require("express");
const { db, db3 } = require("../database/database");
const router = express.Router();
const {
  GWA_UNIT_SQL,
  GWA_EXCLUSION_SQL,
  gwaGradeJoinSql,
} = require("../../utils/gwaSql");

const graduateProgramExclusionSql = (alias) => `
    (
        COALESCE(${alias}.academic_program, 0) IN (1, 2)
        OR UPPER(COALESCE(${alias}.program_code, '')) LIKE '%MASTER%'
        OR UPPER(COALESCE(${alias}.program_code, '')) LIKE '%DOCTOR%'
        OR UPPER(COALESCE(${alias}.program_code, '')) LIKE '%PHD%'
        OR UPPER(COALESCE(${alias}.program_description, '')) LIKE '%MASTER%'
        OR UPPER(COALESCE(${alias}.program_description, '')) LIKE '%MASTERAL%'
        OR UPPER(COALESCE(${alias}.program_description, '')) LIKE '%DOCTOR%'
        OR UPPER(COALESCE(${alias}.program_description, '')) LIKE '%DOCTORAL%'
        OR UPPER(COALESCE(${alias}.program_description, '')) LIKE '%PHD%'
        OR UPPER(COALESCE(${alias}.major, '')) LIKE '%MASTER%'
        OR UPPER(COALESCE(${alias}.major, '')) LIKE '%MASTERAL%'
        OR UPPER(COALESCE(${alias}.major, '')) LIKE '%DOCTOR%'
        OR UPPER(COALESCE(${alias}.major, '')) LIKE '%DOCTORAL%'
        OR UPPER(COALESCE(${alias}.major, '')) LIKE '%PHD%'
    )
`;

const CURRICULUM_FINAL_TERM_SQL = `
    SELECT
        ft_year.curriculum_id,
        ft_year.final_year_level_id,
        MAX(ptt_sem.semester_id) AS final_semester_id
    FROM (
        SELECT
            ptt_yr.curriculum_id,
            MAX(ptt_yr.year_level_id) AS final_year_level_id
        FROM program_tagging_table ptt_yr
        LEFT JOIN year_level_table ylt_yr
            ON ylt_yr.year_level_id = ptt_yr.year_level_id
        WHERE COALESCE(LOWER(ylt_yr.level_type), 'year') = 'year'
        GROUP BY ptt_yr.curriculum_id
    ) ft_year
    INNER JOIN program_tagging_table ptt_sem
        ON  ptt_sem.curriculum_id = ft_year.curriculum_id
        AND ptt_sem.year_level_id = ft_year.final_year_level_id
    GROUP BY ft_year.curriculum_id, ft_year.final_year_level_id
`;

// Sourced from student_status_table (136k rows) instead of enrolled_subject
// (918k rows) — active_curriculum reliably mirrors enrolled_subject.curriculum_id
// for the same student+school year (verified against the live data dump).
const STUDENT_CURRENT_TERM_SQL = `
    SELECT
        ranked.student_number,
        ranked.curriculum_id,
        ranked.year_level_id,
        ranked.semester_id,
        ranked.school_year_id
    FROM (
        SELECT
            sst.student_number,
            sst.active_curriculum AS curriculum_id,
            sst.year_level_id,
            asyt.semester_id,
            asyt.year_id AS school_year_id,
            ROW_NUMBER() OVER (
                PARTITION BY sst.student_number
                ORDER BY asyt.year_id DESC, asyt.semester_id DESC, sst.id DESC
            ) AS rn
        FROM student_status_table sst
        INNER JOIN active_school_year_table asyt
            ON asyt.id = sst.active_school_year_id
        WHERE sst.active_curriculum IS NOT NULL
    ) ranked
    WHERE ranked.rn = 1
`;

const honorRecordDisqualificationSql = (studentAlias) => `
    NOT EXISTS (
        SELECT 1
        FROM enrolled_subject es_bad
        WHERE es_bad.student_number = ${studentAlias}.student_number
            AND (
                -- Institutional status codes: Failed / Incomplete / Dropped
                COALESCE(es_bad.en_remarks, 0) IN (2, 3, 4)
                -- Withdrawn isn't represented in grade_conversion, so check it directly
                OR UPPER(TRIM(COALESCE(CAST(es_bad.grades_status AS CHAR), ''))) IN ('FAIL', 'W')
                -- Any grade (raw score, or text code) grade_conversion marks disqualifying
                OR EXISTS (
                    SELECT 1 FROM grade_conversion gc_bad
                    WHERE gc_bad.is_disqualified = 1
                      AND (
                            UPPER(TRIM(CAST(es_bad.final_grade AS CHAR))) COLLATE utf8mb4_general_ci
                                = UPPER(gc_bad.equivalent_grade) COLLATE utf8mb4_general_ci
                            OR UPPER(TRIM(CAST(es_bad.grades_status AS CHAR))) COLLATE utf8mb4_general_ci
                                = UPPER(gc_bad.equivalent_grade) COLLATE utf8mb4_general_ci
                            OR (
                                gc_bad.min_score IS NOT NULL AND gc_bad.max_score IS NOT NULL
                                AND CAST(es_bad.final_grade AS DECIMAL(8,2)) BETWEEN gc_bad.min_score AND gc_bad.max_score
                            )
                      )
                )
            )
    )
`;

// ─────────────────────────────────────────────────────────────────────────────
// School Year dropdown → shows "2025-2026" (no semester suffix).
//   school_year_id sent to API = year_table.year_id
//   Backend filters with:  asyt.year_id = ?
//
// Semester dropdown → separate filter, pulled from semester_table.
//   semester_id sent to API = semester_table.semester_id
//   Backend filters with:  asyt.semester_id = ?
//
// Both work independently or together. No S1/S2/S3 mixed into the year label.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET /honors/academic_achievers
// ─────────────────────────────────────────────────────────────────────────────
router.get("/honors/academic_achievers", async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = (page - 1) * limit;

    const search = (req.query.search || "").trim();
    const programId = req.query.program_id || "";
    const schoolYearId = req.query.school_year_id || "";
    const semesterId = req.query.semester_id || "";
    const campusId = req.query.campus_id || "";
    const departmentId = req.query.department_id || "";

    // ── Build the latestSyClause dynamically so year/semester filter
    //    happens INSIDE the MAX() subquery — not after it.
    const latestSyParams = [];
    let latestSyWhere = `ss.enrolled_status = '1'`;

    if (schoolYearId) {
      latestSyWhere += ` AND asyt_inner.year_id = ?`;
      latestSyParams.push(schoolYearId);
    }
    if (semesterId) {
      latestSyWhere += ` AND asyt_inner.semester_id = ?`;
      latestSyParams.push(semesterId);
    }

    // This picks the highest active_school_year_id that matches the
    // requested year+semester (or all years if no filter).
    const latestSyClause = `
            SELECT ss.student_number,
                   MAX(ss.active_school_year_id) AS active_school_year_id
            FROM   student_status_table ss
            INNER JOIN active_school_year_table asyt_inner
                   ON asyt_inner.id = ss.active_school_year_id
            WHERE  ${latestSyWhere}
            GROUP  BY ss.student_number
        `;

    // ── Outer filters ──────────────────────────────────────────────────
    const outerConditions = [];
    const outerParams = [];
    outerConditions.push(`NOT ${graduateProgramExclusionSql("pgt")}`);
    outerConditions.push(honorRecordDisqualificationSql("snt"));

    if (search) {
      outerConditions.push(
        `(snt.student_number LIKE ? OR pt.last_name LIKE ? OR pt.first_name LIKE ?)`,
      );
      const s = `${search}%`;
      outerParams.push(s, s, s);
    }
    if (programId) {
      // Use INNER JOIN for program so the filter is reliable
      outerConditions.push(`pgt.program_id = ?`);
      outerParams.push(programId);
    }
    if (campusId) {
      outerConditions.push(`pt.campus = ?`);
      outerParams.push(Number(campusId));
    }
    if (departmentId) {
      // dt is resolved from the student's current-term curriculum below
      // (curriculum_table → dprtmnt_curriculum_table → dprtmnt_table).
      outerConditions.push(`dct.dprtmnt_id = ?`);
      outerParams.push(Number(departmentId));
    }

    const outerWhere = outerConditions.length
      ? `AND ${outerConditions.join(" AND ")}`
      : "";

    // ── GWA formula (as specified):
    //    1. sum of units per subject = total units
    //    2. equivalent grade (from grade_conversion, converted from the
    //       raw final_grade score) * unit = weighted value per subject
    //    3. sum the per-subject weighted values
    //    4. divide by total units
    const dataSql = `
            SELECT
                gwa_calc.student_number,
                gwa_calc.latest_school_year_id,
                gwa_calc.gwa,
                gwa_calc.max_grade,
                gwa_calc.subject_count,
                pt.last_name,
                pt.first_name,
                pt.middle_name,
                pt.emailAddress,
                pt.campus,
                pgt.program_code,
                pgt.program_description,
                pgt.major,
                dt.dprtmnt_name,
                hr.title     AS honor_title,
                hr.min_gwa,
                hr.max_gwa,
                hr.max_subject_grade,
                RANK() OVER (
                    PARTITION BY dt.dprtmnt_id
                    ORDER BY gwa_calc.gwa ASC
                ) AS college_rank,
                RANK() OVER (
                    ORDER BY gwa_calc.gwa ASC
                ) AS overall_rank

            FROM (
                SELECT
                    es.student_number,
                    latest_sy.active_school_year_id                           AS latest_school_year_id,
                    ROUND(
                        SUM(CAST(gc.equivalent_grade AS DECIMAL(10,4)) * ${GWA_UNIT_SQL})
                        / NULLIF(SUM(${GWA_UNIT_SQL}), 0),
                        4
                    ) AS gwa,
                    MAX(CAST(gc.equivalent_grade       AS DECIMAL(10,4)))     AS max_grade,
                    COUNT(es.id)                                              AS subject_count
                FROM (${latestSyClause}) latest_sy
                INNER JOIN enrolled_subject es
                    ON  es.student_number        = latest_sy.student_number
                    AND es.active_school_year_id = latest_sy.active_school_year_id
                INNER JOIN course_table ct
                    ON  ct.course_id            = es.course_id
                    AND ct.is_academic_achiever = 1
                INNER JOIN grade_conversion gc
                    ON  gc.is_disqualified = 0
                    AND gc.min_score IS NOT NULL
                    AND gc.max_score IS NOT NULL
                    AND CAST(es.final_grade AS DECIMAL(8,2)) > 0
                    AND CAST(es.final_grade AS DECIMAL(8,2))
                            BETWEEN gc.min_score AND gc.max_score
                WHERE ${GWA_UNIT_SQL} > 0
                    AND NOT ${GWA_EXCLUSION_SQL}
                GROUP BY es.student_number, latest_sy.active_school_year_id
            ) gwa_calc

            INNER JOIN student_numbering_table snt
                ON  snt.student_number = gwa_calc.student_number
            INNER JOIN person_table pt
                ON  pt.person_id = snt.person_id

            LEFT JOIN enrolled_subject es_prog
                ON  es_prog.id = (
                    SELECT MAX(es2.id) FROM enrolled_subject es2
                    WHERE  es2.student_number        = gwa_calc.student_number
                      AND  es2.active_school_year_id = gwa_calc.latest_school_year_id
                )
            LEFT JOIN curriculum_table ct2
                ON  ct2.curriculum_id = es_prog.curriculum_id
            LEFT JOIN program_table pgt
                ON  pgt.program_id = ct2.program_id
            LEFT JOIN dprtmnt_curriculum_table dct
                ON  dct.curriculum_id = ct2.curriculum_id
            LEFT JOIN dprtmnt_table dt
                ON  dt.dprtmnt_id = dct.dprtmnt_id

            INNER JOIN honors_rules hr
                ON  hr.category        = 0
                AND gwa_calc.gwa       BETWEEN hr.min_gwa AND hr.max_gwa
                AND gwa_calc.max_grade <= hr.max_subject_grade

            WHERE 1=1 ${outerWhere}

            ORDER BY gwa_calc.gwa ASC, pt.last_name ASC
            LIMIT ? OFFSET ?
        `;

    const countSql = `
            SELECT COUNT(*) AS total
            FROM (
                SELECT gwa_calc.student_number
                FROM (
                    SELECT
                        es.student_number,
                        latest_sy.active_school_year_id AS latest_school_year_id,
                        ROUND(
                            SUM(CAST(gc.equivalent_grade AS DECIMAL(10,4)) * ${GWA_UNIT_SQL})
                            / NULLIF(SUM(${GWA_UNIT_SQL}), 0),
                            4
                        ) AS gwa,
                        MAX(CAST(gc.equivalent_grade       AS DECIMAL(10,4)))     AS max_grade
                    FROM (${latestSyClause}) latest_sy
                    INNER JOIN enrolled_subject es
                        ON  es.student_number        = latest_sy.student_number
                        AND es.active_school_year_id = latest_sy.active_school_year_id
                    INNER JOIN course_table ct
                        ON  ct.course_id            = es.course_id
                        AND ct.is_academic_achiever = 1
                    INNER JOIN grade_conversion gc
                        ON  gc.is_disqualified = 0
                        AND gc.min_score IS NOT NULL
                        AND gc.max_score IS NOT NULL
                        AND CAST(es.final_grade AS DECIMAL(8,2)) > 0
                        AND CAST(es.final_grade AS DECIMAL(8,2))
                                BETWEEN gc.min_score AND gc.max_score
                    WHERE ${GWA_UNIT_SQL} > 0
                        AND NOT ${GWA_EXCLUSION_SQL}
                    GROUP BY es.student_number, latest_sy.active_school_year_id
                ) gwa_calc
                INNER JOIN student_numbering_table snt
                    ON snt.student_number = gwa_calc.student_number
                INNER JOIN person_table pt
                    ON pt.person_id = snt.person_id
                LEFT JOIN enrolled_subject es_prog
                    ON es_prog.id = (
                        SELECT MAX(es2.id) FROM enrolled_subject es2
                        WHERE  es2.student_number        = gwa_calc.student_number
                          AND  es2.active_school_year_id = gwa_calc.latest_school_year_id
                    )
                LEFT JOIN curriculum_table ct2
                    ON ct2.curriculum_id = es_prog.curriculum_id
                LEFT JOIN program_table pgt
                    ON pgt.program_id = ct2.program_id
                LEFT JOIN dprtmnt_curriculum_table dct
                    ON dct.curriculum_id = ct2.curriculum_id
                LEFT JOIN dprtmnt_table dt
                    ON dt.dprtmnt_id = dct.dprtmnt_id
                INNER JOIN honors_rules hr
                    ON  hr.category        = 0
                    AND gwa_calc.gwa       BETWEEN hr.min_gwa AND hr.max_gwa
                    AND gwa_calc.max_grade <= hr.max_subject_grade
                WHERE 1=1 ${outerWhere}
            ) counted
        `;

    // latestSyParams used twice (data + count), outerParams used twice
    const allLatest = [...latestSyParams];
    const allOuter = [...outerParams];

    const [rows] = await db3.query(dataSql, [
      ...allLatest,
      ...allOuter,
      limit,
      offset,
    ]);
    const [countRows] = await db3.query(countSql, [...allLatest, ...allOuter]);

    res.json({
      data: rows,
      total: countRows[0].total,
      page,
      totalPages: Math.ceil(countRows[0].total / limit),
    });
  } catch (err) {
    console.error("Academic achievers error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /honors/latin_honors
// ─────────────────────────────────────────────────────────────────────────────
router.get("/honors/latin_honors", async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = (page - 1) * limit;

    const search = (req.query.search || "").trim();
    const programId = req.query.program_id || "";
    const campusId = req.query.campus_id || "";
    const schoolYearId = req.query.school_year_id || "";
    const departmentId = req.query.department_id || "";

    const eligibleConditions = [];
    const eligibleParams = [];
    eligibleConditions.push(`NOT ${graduateProgramExclusionSql("pgt")}`);
    eligibleConditions.push(honorRecordDisqualificationSql("snt"));

    // Scopes eligibility to "final term AS OF this school year" instead
    // of "final term, ever" — keeps already-processed prior-year
    // graduates from permanently showing up here.
    if (schoolYearId) {
      eligibleConditions.push(`sct.school_year_id = ?`);
      eligibleParams.push(schoolYearId);
    }

    if (search) {
      eligibleConditions.push(
        `(snt.student_number LIKE ? OR pt.last_name LIKE ? OR pt.first_name LIKE ?)`,
      );
      const s = `${search}%`;
      eligibleParams.push(s, s, s);
    }
    if (programId) {
      eligibleConditions.push(`pgt.program_id = ?`);
      eligibleParams.push(programId);
    }
    if (campusId) {
      eligibleConditions.push(`pt.campus = ?`);
      eligibleParams.push(Number(campusId));
    }
    if (departmentId) {
      // dct is resolved from the graduating curriculum below
      // (curriculum_table → dprtmnt_curriculum_table → dprtmnt_table),
      // same college/department join already used to display dt.dprtmnt_name.
      eligibleConditions.push(`dct.dprtmnt_id = ?`);
      eligibleParams.push(Number(departmentId));
    }

    const eligibleWhere = eligibleConditions.length
      ? `AND ${eligibleConditions.join(" AND ")}`
      : "";

    const eligibleStudentsSql = `
            SELECT DISTINCT sct.student_number
            FROM (${STUDENT_CURRENT_TERM_SQL}) sct
            INNER JOIN (${CURRICULUM_FINAL_TERM_SQL}) cft
                ON  cft.curriculum_id       = sct.curriculum_id
                AND cft.final_year_level_id = sct.year_level_id
                AND cft.final_semester_id   = sct.semester_id
            INNER JOIN student_numbering_table snt
                ON  snt.student_number = sct.student_number
            INNER JOIN person_table pt
                ON  pt.person_id = snt.person_id
            LEFT JOIN curriculum_table ct2
                ON  ct2.curriculum_id = sct.curriculum_id
            LEFT JOIN program_table pgt
                ON  pgt.program_id = ct2.program_id
            LEFT JOIN dprtmnt_curriculum_table dct
                ON  dct.curriculum_id = ct2.curriculum_id
            WHERE 1=1 ${eligibleWhere}
        `;

    const dataSql = `
            SELECT
                gwa_calc.student_number,
                gwa_calc.cumulative_gwa,
                gwa_calc.max_grade,
                gwa_calc.subject_count,
                pt.last_name,
                pt.first_name,
                pt.middle_name,
                pt.emailAddress,
                pt.campus,
                pgt.program_code,
                pgt.program_description,
                pgt.major,
                dt.dprtmnt_name,
                hr.title AS latin_honor,
                hr.min_gwa,
                hr.max_gwa,
                hr.max_subject_grade,
                RANK() OVER (
                    PARTITION BY dt.dprtmnt_id
                    ORDER BY gwa_calc.cumulative_gwa ASC
                ) AS college_rank,
                RANK() OVER (
                    ORDER BY gwa_calc.cumulative_gwa ASC
                ) AS overall_rank

            FROM (
                SELECT
                    es.student_number,
                    ROUND(
                        SUM(CAST(gc.equivalent_grade AS DECIMAL(10,4)) * ${GWA_UNIT_SQL})
                        / NULLIF(SUM(${GWA_UNIT_SQL}), 0),
                        4
                    ) AS cumulative_gwa,
                    MAX(CAST(gc.equivalent_grade AS DECIMAL(10,4))) AS max_grade,
                    COUNT(es.id) AS subject_count
                FROM (${eligibleStudentsSql}) eligible
                INNER JOIN enrolled_subject es
                    ON  es.student_number = eligible.student_number
                    AND es.en_remarks     = 1
                INNER JOIN student_status_table ss
                    ON  ss.student_number        = es.student_number
                    AND ss.active_school_year_id = es.active_school_year_id
                    AND ss.enrolled_status       = '1'
                INNER JOIN course_table ct
                    ON  ct.course_id = es.course_id
                    AND ct.is_latin  = 1
                INNER JOIN grade_conversion gc
                    ON  gc.is_disqualified = 0
                    AND gc.min_score IS NOT NULL
                    AND gc.max_score IS NOT NULL
                    AND CAST(es.final_grade AS DECIMAL(8,2)) > 0
                    AND CAST(es.final_grade AS DECIMAL(8,2))
                            BETWEEN gc.min_score AND gc.max_score
                WHERE ${GWA_UNIT_SQL} > 0
                    AND NOT ${GWA_EXCLUSION_SQL}
                GROUP BY es.student_number
            ) gwa_calc

            INNER JOIN student_numbering_table snt
                ON  snt.student_number = gwa_calc.student_number
            INNER JOIN person_table pt
                ON  pt.person_id = snt.person_id
            LEFT JOIN (${STUDENT_CURRENT_TERM_SQL}) sct
                ON  sct.student_number = gwa_calc.student_number
            LEFT JOIN curriculum_table ct2
                ON  ct2.curriculum_id = sct.curriculum_id
            LEFT JOIN program_table pgt
                ON  pgt.program_id = ct2.program_id
            LEFT JOIN dprtmnt_curriculum_table dct
                ON  dct.curriculum_id = ct2.curriculum_id
            LEFT JOIN dprtmnt_table dt
                ON  dt.dprtmnt_id = dct.dprtmnt_id

            INNER JOIN honors_rules hr
                ON  hr.category             = 1
                AND gwa_calc.cumulative_gwa BETWEEN hr.min_gwa AND hr.max_gwa
                AND gwa_calc.max_grade      <= hr.max_subject_grade

            ORDER BY gwa_calc.cumulative_gwa ASC, pt.last_name ASC
            LIMIT ? OFFSET ?
        `;

    const countSql = `
            SELECT COUNT(*) AS total
            FROM (
                SELECT
                    es.student_number,
                    ROUND(
                        SUM(CAST(gc.equivalent_grade AS DECIMAL(10,4)) * ${GWA_UNIT_SQL})
                        / NULLIF(SUM(${GWA_UNIT_SQL}), 0),
                        4
                    ) AS cumulative_gwa,
                    MAX(CAST(gc.equivalent_grade AS DECIMAL(10,4))) AS max_grade
                FROM (${eligibleStudentsSql}) eligible
                INNER JOIN enrolled_subject es
                    ON  es.student_number = eligible.student_number
                    AND es.en_remarks     = 1
                INNER JOIN student_status_table ss
                    ON  ss.student_number        = es.student_number
                    AND ss.active_school_year_id = es.active_school_year_id
                    AND ss.enrolled_status       = '1'
                INNER JOIN course_table ct
                    ON  ct.course_id = es.course_id
                    AND ct.is_latin  = 1
                INNER JOIN grade_conversion gc
                    ON  gc.is_disqualified = 0
                    AND gc.min_score IS NOT NULL
                    AND gc.max_score IS NOT NULL
                    AND CAST(es.final_grade AS DECIMAL(8,2)) > 0
                    AND CAST(es.final_grade AS DECIMAL(8,2))
                            BETWEEN gc.min_score AND gc.max_score
                WHERE ${GWA_UNIT_SQL} > 0
                    AND NOT ${GWA_EXCLUSION_SQL}
                GROUP BY es.student_number
            ) gwa_calc
            INNER JOIN honors_rules hr
                ON  hr.category             = 1
                AND gwa_calc.cumulative_gwa BETWEEN hr.min_gwa AND hr.max_gwa
                AND gwa_calc.max_grade      <= hr.max_subject_grade
        `;

    const [rows] = await db3.query(dataSql, [...eligibleParams, limit, offset]);
    const [countRows] = await db3.query(countSql, [...eligibleParams]);

    res.json({
      data: rows,
      total: countRows[0].total,
      page,
      totalPages: Math.ceil(countRows[0].total / limit),
    });
  } catch (err) {
    console.error("Latin honors error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /honors/school_years
// One entry per academic year — "2025-2026", "2024-2025", etc.
// Highest year first. school_year_id = year_table.year_id.
// Semester is a SEPARATE filter — not mixed into this dropdown at all.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/honors/school_years", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT
        yt.year_id                                                    AS school_year_id,
        CONCAT(yt.year_description, '-', (yt.year_description + 1))  AS school_year_description
      FROM year_table yt
      WHERE EXISTS (
        SELECT 1 FROM active_school_year_table asyt
        WHERE asyt.year_id = yt.year_id
      )
      ORDER BY yt.year_description DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /honors/semesters
// First Semester / Second Semester / Summer — from semester_table.
// Used by the Semester dropdown (academic achievers tab only).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/honors/semesters", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT semester_id, semester_description, semester_code
      FROM   semester_table
      ORDER  BY semester_id ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /honors/programs
// ─────────────────────────────────────────────────────────────────────────────
router.get("/honors/programs", async (req, res) => {
  try {
    const campusId = req.query.campus_id || "";
    const params = [];
    let campusWhere = "";

    if (campusId) {
      campusWhere = `
                AND EXISTS (
                    SELECT 1
                    FROM student_numbering_table snt
                    INNER JOIN person_table pt
                        ON pt.person_id = snt.person_id
                    INNER JOIN enrolled_subject es
                        ON es.student_number = snt.student_number
                    INNER JOIN curriculum_table ct
                        ON ct.curriculum_id = es.curriculum_id
                    WHERE ct.program_id = p.program_id
                        AND pt.campus = ?
                )
            `;
      params.push(Number(campusId));
    }

    const [rows] = await db3.query(
      `
      SELECT program_id, program_code, program_description, major
      FROM   program_table p
      WHERE  NOT ${graduateProgramExclusionSql("p")}
        ${campusWhere}
      ORDER  BY program_code ASC
    `,
      params,
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /honors/departments
// Powers the new "College" filter — reuses the same
// curriculum_table → dprtmnt_curriculum_table → dprtmnt_table chain the
// academic_achievers / latin_honors queries already join on to resolve
// dt.dprtmnt_name, so "College" here always means the same college those
// two reports display.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/honors/departments", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT dprtmnt_id, dprtmnt_name, dprtmnt_code
      FROM   dprtmnt_table
      WHERE  is_allowed = 1
      ORDER  BY dprtmnt_name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /honors/gwa_printing_status
// Powers the Download buttons on StudentGradePage (overall + per-semester).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/honors/gwa_printing_status", async (req, res) => {
  try {
    const [rows] = await db3.query(
      `SELECT gwa_type, description, status FROM gwa_period_status_table`,
    );

    const byType = rows.reduce((acc, row) => {
      acc[row.gwa_type] = Boolean(Number(row.status));
      return acc;
    }, {});

    res.json({
      overall: byType.overall ?? false,
      per_semester: byType.per_semester ?? false,
    });
  } catch (err) {
    console.error("Failed to fetch GWA printing status:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /honors/gwa_printing_status
// Body: { gwa_type: 'overall' | 'per_semester', status: 0 | 1, updated_by }
// Toggles opening/closing of GWA printing for that scope.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/honors/gwa_printing_status", async (req, res) => {
  const { gwa_type, status, updated_by } = req.body;

  if (
    !["overall", "per_semester"].includes(gwa_type) ||
    ![0, 1].includes(Number(status))
  ) {
    return res.status(400).json({
      success: false,
      message:
        "gwa_type must be 'overall' or 'per_semester', and status must be 0 or 1.",
    });
  }

  try {
    const isOpen = Number(status) === 1;

    const [result] = await db3.query(
      `UPDATE gwa_period_status_table
             SET status     = ?,
                 opened_at  = CASE WHEN ? = 1 THEN NOW() ELSE opened_at END,
                 closed_at  = CASE WHEN ? = 0 THEN NOW() ELSE closed_at END,
                 updated_by = ?
             WHERE gwa_type = ?`,
      [status, status, status, updated_by || null, gwa_type],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "GWA type not found." });
    }

    res.json({
      success: true,
      message: `${gwa_type === "overall" ? "Overall" : "Per-semester"} GWA printing is now ${isOpen ? "OPEN" : "CLOSED"}.`,
    });
  } catch (err) {
    console.error("Failed to update GWA printing status:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
