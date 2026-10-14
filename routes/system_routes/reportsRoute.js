const express = require("express");
const { db3 } = require("../database/database");

const router = express.Router();

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const isAll = (value) => !value || String(value).toLowerCase() === "all";

const parseDateFilter = (value) => {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
};

const STUDENT_NAME_EXPRESSION = `TRIM(CONCAT(
  COALESCE(person.last_name, ''),
  CASE WHEN COALESCE(person.last_name, '') <> '' THEN ', ' ELSE '' END,
  COALESCE(person.first_name, ''),
  CASE WHEN COALESCE(person.middle_name, '') <> '' THEN CONCAT(' ', person.middle_name) ELSE '' END,
  CASE WHEN COALESCE(person.extension, '') <> '' THEN CONCAT(' ', person.extension) ELSE '' END
))`;

const buildReportSource = ({
  type,
  campusId,
  activeSchoolYearId,
  curriculumId,
  yearLevelId,
  sectionId,
  startDate,
  endDate,
}) => {
  const conditions = [
    "es.active_school_year_id = ?",
    "pt.components = ?",
  ];
  const params = [activeSchoolYearId, campusId];

  // Enrolled reports with "All" curricula should include students assigned
  // to inactive curricula. Keep the active-curriculum restriction for
  // migrated reports and when a specific curriculum is selected.
  if (type !== "enrolled" || !isAll(curriculumId)) {
    conditions.push("ct.lock_status = 1");
  }

  if (type === "migrated") {
    conditions.push("LOWER(TRIM(COALESCE(es.remarks, ''))) = 'migrated from old system'");
  } else {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM unifast AS u
        WHERE u.student_number = es.student_number
          AND u.active_school_year_id = es.active_school_year_id
          AND u.status = 1
      )`,
    );
  }

  if (!isAll(curriculumId)) {
    conditions.push("es.curriculum_id = ?");
    params.push(curriculumId);
  }

  if (!isAll(yearLevelId)) {
    conditions.push("sst.year_level_id = ?");
    params.push(yearLevelId);
  }

  if (type === "enrolled" && !isAll(sectionId)) {
    conditions.push("es.department_section_id = ?");
    params.push(sectionId);
  }

  if (startDate) {
    conditions.push("es.created_at >= ?");
    params.push(`${startDate} 00:00:00`);
  }

  if (endDate) {
    conditions.push("es.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${endDate} 00:00:00`);
  }

  return {
    sql: `
      SELECT DISTINCT
        es.student_number,
        es.curriculum_id,
        sst.year_level_id
      FROM enrolled_subject AS es
      INNER JOIN curriculum_table AS ct
        ON ct.curriculum_id = es.curriculum_id
      INNER JOIN program_table AS pt
        ON pt.program_id = ct.program_id
      INNER JOIN (
        SELECT student_number, active_school_year_id, MAX(id) AS latest_status_id
        FROM student_status_table
        GROUP BY student_number, active_school_year_id
      ) AS latest_status
        ON latest_status.student_number = es.student_number
       AND latest_status.active_school_year_id = es.active_school_year_id
      INNER JOIN student_status_table AS sst
        ON sst.id = latest_status.latest_status_id
      WHERE ${conditions.join(" AND ")}
    `,
    params,
  };
};

const getReport = async (req, res, type) => {
  const campusId = toPositiveInteger(req.query.campusId);
  const activeSchoolYearId = toPositiveInteger(req.query.activeSchoolYearId);
  const curriculumId = isAll(req.query.curriculumId)
    ? "all"
    : toPositiveInteger(req.query.curriculumId);
  const yearLevelId = isAll(req.query.yearLevelId)
    ? "all"
    : toPositiveInteger(req.query.yearLevelId);
  const sectionId = isAll(req.query.sectionId)
    ? "all"
    : toPositiveInteger(req.query.sectionId);
  const page = Math.max(toPositiveInteger(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(toPositiveInteger(req.query.pageSize) || 25, 1), 100);
  const search = String(req.query.search || "").trim();
  const startDate = parseDateFilter(req.query.startDate);
  const endDate = parseDateFilter(req.query.endDate);

  if (!campusId || !activeSchoolYearId) {
    return res.status(400).json({
      error: "campusId and activeSchoolYearId are required",
    });
  }

  if (!curriculumId || !yearLevelId || (type === "enrolled" && !sectionId)) {
    return res.status(400).json({ error: "Invalid report filter" });
  }

  if ((req.query.startDate && !startDate) || (req.query.endDate && !endDate)) {
    return res.status(400).json({ error: "Dates must use the YYYY-MM-DD format" });
  }

  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({ error: "Start date cannot be after end date" });
  }

  try {
    const source = buildReportSource({
      type,
      campusId,
      activeSchoolYearId,
      curriculumId,
      yearLevelId,
      sectionId,
      startDate,
      endDate,
    });

    const [curriculumRows] = await db3.query(
      `
        SELECT
          base.curriculum_id,
          CONCAT(
            pt.program_code,
            ' - ',
            pt.program_description,
            ' (Curriculum ',
            yt.year_description,
            ')'
          ) AS curriculum_name,
          COUNT(DISTINCT base.student_number) AS student_count
        FROM (${source.sql}) AS base
        INNER JOIN curriculum_table AS ct
          ON ct.curriculum_id = base.curriculum_id
        INNER JOIN program_table AS pt
          ON pt.program_id = ct.program_id
        INNER JOIN year_table AS yt
          ON yt.year_id = ct.year_id
        GROUP BY base.curriculum_id, pt.program_code, pt.program_description, yt.year_description
        ORDER BY pt.program_code, yt.year_description DESC
      `,
      source.params,
    );

    const [yearLevelRows] = await db3.query(
      `
        SELECT
          base.year_level_id,
          COALESCE(ylt.year_level_description, 'Unspecified') AS year_level_name,
          COUNT(DISTINCT base.student_number) AS student_count
        FROM (${source.sql}) AS base
        LEFT JOIN year_level_table AS ylt
          ON ylt.year_level_id = base.year_level_id
        GROUP BY base.year_level_id, ylt.year_level_description
        ORDER BY base.year_level_id
      `,
      source.params,
    );

    const [[totalRow]] = await db3.query(
      `SELECT COUNT(DISTINCT base.student_number) AS total_students FROM (${source.sql}) AS base`,
      source.params,
    );

    const searchCondition = search
      ? `WHERE base.student_number LIKE ? OR ${STUDENT_NAME_EXPRESSION} LIKE ?`
      : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [[countRow]] = await db3.query(
      `
        SELECT COUNT(*) AS total_records
        FROM (
          SELECT DISTINCT base.student_number
          FROM (${source.sql}) AS base
          INNER JOIN student_numbering_table AS numbering
            ON numbering.student_number = base.student_number
          INNER JOIN person_table AS person
            ON person.person_id = numbering.person_id
          ${searchCondition}
        ) AS student_list
      `,
      [...source.params, ...searchParams],
    );

    const [studentRows] = await db3.query(
      `
        SELECT
          base.student_number,
          ${STUDENT_NAME_EXPRESSION} AS student_full_name,
          GROUP_CONCAT(
            DISTINCT CONCAT(
              pt.program_code,
              ' - ',
              pt.program_description,
              CASE
                WHEN COALESCE(pt.major, '') <> '' THEN CONCAT(' - ', pt.major)
                ELSE ''
              END,
              ' (Curriculum ',
              yt.year_description,
              ')'
            )
            ORDER BY pt.program_code, yt.year_description DESC
            SEPARATOR '; '
          ) AS curriculum_name
        FROM (${source.sql}) AS base
        INNER JOIN student_numbering_table AS numbering
          ON numbering.student_number = base.student_number
        INNER JOIN person_table AS person
          ON person.person_id = numbering.person_id
        INNER JOIN curriculum_table AS ct
          ON ct.curriculum_id = base.curriculum_id
        INNER JOIN program_table AS pt
          ON pt.program_id = ct.program_id
        INNER JOIN year_table AS yt
          ON yt.year_id = ct.year_id
        ${searchCondition}
        GROUP BY
          base.student_number,
          person.last_name,
          person.first_name,
          person.middle_name,
          person.extension
        ORDER BY person.last_name, person.first_name, person.middle_name, base.student_number
        LIMIT ? OFFSET ?
      `,
      [...source.params, ...searchParams, pageSize, (page - 1) * pageSize],
    );

    return res.json({
      summary: { total_students: Number(totalRow?.total_students || 0) },
      by_curriculum: curriculumRows,
      by_year_level: yearLevelRows,
      students: studentRows,
      pagination: {
        page,
        page_size: pageSize,
        total_records: Number(countRow?.total_records || 0),
      },
    });
  } catch (error) {
    console.error(`Failed to load ${type} report:`, error);
    return res.status(500).json({ error: `Failed to load ${type} report` });
  }
};

const exportReport = async (req, res, type) => {
  const campusId = toPositiveInteger(req.query.campusId);
  const activeSchoolYearId = toPositiveInteger(req.query.activeSchoolYearId);
  const curriculumId = isAll(req.query.curriculumId)
    ? "all"
    : toPositiveInteger(req.query.curriculumId);
  const yearLevelId = isAll(req.query.yearLevelId)
    ? "all"
    : toPositiveInteger(req.query.yearLevelId);
  const sectionId = isAll(req.query.sectionId)
    ? "all"
    : toPositiveInteger(req.query.sectionId);
  const search = String(req.query.search || "").trim();
  const startDate = parseDateFilter(req.query.startDate);
  const endDate = parseDateFilter(req.query.endDate);

  if (!campusId || !activeSchoolYearId) {
    return res.status(400).json({
      error: "campusId and activeSchoolYearId are required",
    });
  }

  if (!curriculumId || !yearLevelId || (type === "enrolled" && !sectionId)) {
    return res.status(400).json({ error: "Invalid report filter" });
  }

  if ((req.query.startDate && !startDate) || (req.query.endDate && !endDate)) {
    return res.status(400).json({ error: "Dates must use the YYYY-MM-DD format" });
  }

  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({ error: "Start date cannot be after end date" });
  }

  try {
    const source = buildReportSource({
      type,
      campusId,
      activeSchoolYearId,
      curriculumId,
      yearLevelId,
      sectionId,
      startDate,
      endDate,
    });
    const searchCondition = search
      ? `WHERE base.student_number LIKE ? OR ${STUDENT_NAME_EXPRESSION} LIKE ?`
      : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [students] = await db3.query(
      `
        SELECT
          base.student_number,
          ${STUDENT_NAME_EXPRESSION} AS student_full_name,
          GROUP_CONCAT(
            DISTINCT CONCAT(
              pt.program_code,
              ' - ',
              pt.program_description,
              CASE
                WHEN COALESCE(pt.major, '') <> '' THEN CONCAT(' - ', pt.major)
                ELSE ''
              END,
              ' (Curriculum ',
              yt.year_description,
              ')'
            )
            ORDER BY pt.program_code, yt.year_description DESC
            SEPARATOR '; '
          ) AS curriculum_name
        FROM (${source.sql}) AS base
        INNER JOIN student_numbering_table AS numbering
          ON numbering.student_number = base.student_number
        INNER JOIN person_table AS person
          ON person.person_id = numbering.person_id
        INNER JOIN curriculum_table AS ct
          ON ct.curriculum_id = base.curriculum_id
        INNER JOIN program_table AS pt
          ON pt.program_id = ct.program_id
        INNER JOIN year_table AS yt
          ON yt.year_id = ct.year_id
        ${searchCondition}
        GROUP BY
          base.student_number,
          person.last_name,
          person.first_name,
          person.middle_name,
          person.extension
        ORDER BY person.last_name, person.first_name, person.middle_name, base.student_number
      `,
      [...source.params, ...searchParams],
    );

    return res.json({ students });
  } catch (error) {
    console.error(`Failed to export ${type} report:`, error);
    return res.status(500).json({ error: `Failed to export ${type} report` });
  }
};

router.get("/reports/filter-options", async (req, res) => {
  const campusId = toPositiveInteger(req.query.campusId);
  const curriculumId = isAll(req.query.curriculumId)
    ? null
    : toPositiveInteger(req.query.curriculumId);
  const yearLevelId = isAll(req.query.yearLevelId)
    ? null
    : toPositiveInteger(req.query.yearLevelId);
  const activeSchoolYearId = toPositiveInteger(req.query.activeSchoolYearId);

  if (!campusId) {
    return res.status(400).json({ error: "campusId is required" });
  }

  try {
    const [curricula] = await db3.query(
      `
        SELECT
          ct.curriculum_id,
          ct.year_id,
          pt.program_id,
          pt.program_code,
          pt.program_description,
          pt.major,
          pt.components,
          yt.year_description,
          CONCAT(
            pt.program_code,
            ' - ',
            pt.program_description,
            CASE WHEN COALESCE(pt.major, '') <> '' THEN CONCAT(' - ', pt.major) ELSE '' END,
            ' (Curriculum ',
            yt.year_description,
            ')'
          ) AS curriculum_name
        FROM curriculum_table AS ct
        INNER JOIN program_table AS pt ON pt.program_id = ct.program_id
        INNER JOIN year_table AS yt ON yt.year_id = ct.year_id
        WHERE ct.lock_status = 1 AND pt.components = ?
        ORDER BY pt.program_code, yt.year_description DESC
      `,
      [campusId],
    );

    const [terms] = await db3.query(
      `
        SELECT
          asy.id AS active_school_year_id,
          asy.year_id,
          asy.semester_id,
          asy.astatus,
          yt.year_description,
          st.semester_description
        FROM active_school_year_table AS asy
        INNER JOIN year_table AS yt ON yt.year_id = asy.year_id
        INNER JOIN semester_table AS st ON st.semester_id = asy.semester_id
        ORDER BY asy.astatus DESC, yt.year_description DESC, asy.semester_id
      `,
    );

    const [yearLevels] = await db3.query(
      `
        SELECT year_level_id, year_level_description
        FROM year_level_table
        WHERE level_type IN ('year', 'graduate') OR level_type IS NULL
        ORDER BY year_level_id
      `,
    );

    let sections = [];
    if (curriculumId) {
      const conditions = ["dst.curriculum_id = ?"];
      const params = [curriculumId];

      if (yearLevelId) {
        conditions.push("dst.year_level_id = ?");
        params.push(yearLevelId);
      }

      if (activeSchoolYearId) {
        conditions.push(`(
          dst.dsstat = 1 OR EXISTS (
            SELECT 1
            FROM enrolled_subject AS existing_enrollment
            WHERE existing_enrollment.department_section_id = dst.id
              AND existing_enrollment.active_school_year_id = ?
          )
        )`);
        params.push(activeSchoolYearId);
      } else {
        conditions.push("dst.dsstat = 1");
      }

      const [sectionRows] = await db3.query(
        `
          SELECT
            dst.id AS department_section_id,
            dst.year_level_id,
            st.description AS section_description,
            CONCAT(pt.program_code, ' - ', st.description) AS section_name
          FROM dprtmnt_section_table AS dst
          INNER JOIN section_table AS st ON st.id = dst.section_id
          INNER JOIN curriculum_table AS ct ON ct.curriculum_id = dst.curriculum_id
          INNER JOIN program_table AS pt ON pt.program_id = ct.program_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY dst.year_level_id, st.description
        `,
        params,
      );
      sections = sectionRows;
    }

    return res.json({ curricula, terms, year_levels: yearLevels, sections });
  } catch (error) {
    console.error("Failed to load report filter options:", error);
    return res.status(500).json({ error: "Failed to load report filter options" });
  }
});

router.get("/reports/migrated", (req, res) => getReport(req, res, "migrated"));
router.get("/reports/enrolled", (req, res) => getReport(req, res, "enrolled"));
router.get("/reports/migrated/export", (req, res) => exportReport(req, res, "migrated"));
router.get("/reports/enrolled/export", (req, res) => exportReport(req, res, "enrolled"));

module.exports = router;
