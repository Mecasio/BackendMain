const express = require("express");
const { db3 } = require("../database/database");

const router = express.Router();

router.get("/list_of_students/details", async (req, res) => {
  const {
    departmentId,
    dprtmnt_id,
    departmentIds: departmentIdsRaw,
    yearId,
    semesterId,
    search: searchRaw,
    campus,
    programCode,
    major,
    page: pageRaw,
    limit: limitRaw,
  } = req.query;

  const selectedDepartmentId = departmentId || dprtmnt_id;
  const departmentIds = String(departmentIdsRaw || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!selectedDepartmentId && departmentIds.length === 0) {
    return res.status(400).json({
      message: "Department ID or departmentIds is required",
    });
  }

  if (!yearId || !semesterId) {
    return res.status(400).json({
      message: "School year and semester are required",
    });
  }

  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const DEFAULT_LIMIT = 100;
  const MAX_LIMIT = 500;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(limitRaw, 10) || DEFAULT_LIMIT),
  );
  const offset = (page - 1) * limit;
  const search = String(searchRaw || "").trim();
  const campusFilter = String(campus || "").trim();
  const programCodeFilter = String(programCode || "").trim();
  const majorFilter = String(major || "").trim();

  const deptPlaceholders = selectedDepartmentId
    ? "?"
    : departmentIds.map(() => "?").join(", ");
  const deptParams = selectedDepartmentId
    ? [selectedDepartmentId]
    : departmentIds;

  const baseFromSql = `
      FROM (
        SELECT
          es.student_number,
          es.active_school_year_id,
          MIN(es.curriculum_id) AS curriculum_id,
          MAX(es.en_remarks) AS en_remarks
        FROM enrolled_subject es
        INNER JOIN dprtmnt_curriculum_table dct
          ON es.curriculum_id = dct.curriculum_id
        INNER JOIN active_school_year_table asyt_filter
          ON es.active_school_year_id = asyt_filter.id
        WHERE dct.dprtmnt_id IN (${deptPlaceholders})
          AND asyt_filter.year_id = ?
          AND asyt_filter.semester_id = ?
        GROUP BY es.student_number, es.active_school_year_id
      ) es
      INNER JOIN student_numbering_table snt
        ON es.student_number = snt.student_number
      INNER JOIN person_table pt
        ON snt.person_id = pt.person_id
      INNER JOIN curriculum_table ct
        ON es.curriculum_id = ct.curriculum_id
      INNER JOIN program_table pgt
        ON ct.program_id = pgt.program_id
      INNER JOIN dprtmnt_curriculum_table dct
        ON es.curriculum_id = dct.curriculum_id
       AND dct.dprtmnt_id IN (${deptPlaceholders})
      INNER JOIN dprtmnt_table dpt
        ON dct.dprtmnt_id = dpt.dprtmnt_id
      INNER JOIN student_status_table sst
        ON es.student_number = sst.student_number
       AND es.active_school_year_id = sst.active_school_year_id
      INNER JOIN year_level_table ylt
        ON sst.year_level_id = ylt.year_level_id
      LEFT JOIN active_school_year_table asyt
        ON es.active_school_year_id = asyt.id
      LEFT JOIN year_table yt
        ON asyt.year_id = yt.year_id
      LEFT JOIN semester_table smt
        ON asyt.semester_id = smt.semester_id
  `;

  const whereParts = [];
  const filterParams = [
    ...deptParams,
    yearId,
    semesterId,
    ...deptParams,
  ];

  if (search) {
    whereParts.push(`(
      CAST(snt.student_number AS CHAR) LIKE ?
      OR pt.first_name LIKE ?
      OR pt.middle_name LIKE ?
      OR pt.last_name LIKE ?
      OR CONCAT_WS(' ', pt.first_name, pt.middle_name, pt.last_name) LIKE ?
      OR pgt.program_description LIKE ?
      OR dpt.dprtmnt_code LIKE ?
    )`);
    const like = `%${search}%`;
    filterParams.push(like, like, like, like, like, like, like);
  }

  if (campusFilter) {
    whereParts.push(`CAST(pt.campus AS CHAR) = ?`);
    filterParams.push(campusFilter);
  }

  if (programCodeFilter) {
    whereParts.push(`pgt.program_code = ?`);
    filterParams.push(programCodeFilter);
    if (majorFilter) {
      whereParts.push(`IFNULL(pgt.major, '') = ?`);
      filterParams.push(majorFilter);
    } else {
      whereParts.push(`(pgt.major IS NULL OR pgt.major = '')`);
    }
  }

  const whereSql = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";

  try {
    const [countRows] = await db3.query(
      `SELECT COUNT(*) AS total ${baseFromSql}${whereSql}`,
      filterParams,
    );
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit) || 1);

    const [rows] = await db3.query(
      `
      SELECT
        pt.person_id,
        pt.campus,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        pt.extension,
        pt.birthOfDate,
        pt.gender,
        snt.student_number,
        es.active_school_year_id,
        asyt.year_id,
        asyt.semester_id,
        yt.year_description,
        smt.semester_description,
        ct.curriculum_id,
        pgt.program_id,
        pgt.program_description,
        pgt.program_code,
        pgt.major,  
        dpt.dprtmnt_id,
        dpt.dprtmnt_name,
        dpt.dprtmnt_code,
        dpt.dept_number,
        dpt.components,
        sst.year_level_id,
        es.en_remarks AS en_remarks,
        es.en_remarks AS remark_summary,
        ylt.year_level_description
      ${baseFromSql}${whereSql}
      ORDER BY asyt.year_id ASC, asyt.semester_id ASC, snt.student_number ASC
      LIMIT ? OFFSET ?
      `,
      [...filterParams, limit, offset],
    );

    res.status(200).json({
      data: rows,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    console.error("Error fetching student list details by department:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;
