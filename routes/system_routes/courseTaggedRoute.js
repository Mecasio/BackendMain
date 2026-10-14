const express = require('express');
const { db3 } = require('../database/database');
const router = express.Router();

/**
 * ===================== COURSE TAGGING REPORT =====================
 * Read-only module that answers: "which courses are tagged into which
 * curricula, and how many times?" Built off program_tagging_table,
 * which is the join table between course_table and curriculum_table.
 *
 * A course can be tagged multiple times (different curricula, or
 * even multiple slots within the same curriculum), so this reports
 * a COUNT rather than assuming a 1:1 relationship.
 */

/* ------------- GET /api/course-tagging-summary -------------
   Server-side paginated + filtered. Query params:
     page    (default 1)
     limit   (default 100, max 500)
     search  matches course_code / course_description
     tagged  "tagged" | "untagged"
     prereq  "yes" | "no"
     nstp    "1" -> only courses with at least one NSTP-flagged tagging
   Response shape: { rows, total, page, limit, totalPages } */
router.get('/course-tagging-summary', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = (page - 1) * limit;

  const search = (req.query.search || '').trim();
  const tagged = req.query.tagged || '';
  const prereq = req.query.prereq || '';
  const nstpOnly = req.query.nstp === '1';

  const whereClauses = [];
  const params = [];

  if (search) {
    whereClauses.push('(c.course_code LIKE ? OR c.course_description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  if (tagged === 'tagged') {
    whereClauses.push('pc.times_tagged > 0');
  } else if (tagged === 'untagged') {
    whereClauses.push('(pc.times_tagged IS NULL OR pc.times_tagged = 0)');
  }

  if (prereq === 'yes') {
    whereClauses.push("(c.prereq IS NOT NULL AND TRIM(c.prereq) <> '')");
  } else if (prereq === 'no') {
    whereClauses.push("(c.prereq IS NULL OR TRIM(c.prereq) = '')");
  }

  if (nstpOnly) {
    whereClauses.push(`EXISTS (
      SELECT 1 FROM program_tagging_table pt_nstp
      WHERE pt_nstp.course_id = c.course_id AND pt_nstp.is_nstp = 1
    )`);
  }

  const whereSQL = whereClauses.length
    ? `WHERE ${whereClauses.join(' AND ')}`
    : '';

  // Shared FROM/JOIN so the data query and the count query stay in sync.
  const baseFrom = `
    FROM course_table c
    LEFT JOIN subject_type_table st ON c.subject_type_id = st.subject_type_id
    LEFT JOIN category_type_table ct ON c.category_type_id = ct.category_type_id
    LEFT JOIN (
      SELECT
        t.course_id,
        COUNT(*) AS times_tagged,
        COUNT(DISTINCT t.program_id) AS programs_count,
        GROUP_CONCAT(
          CONCAT_WS(
            ':',
            t.program_code,
            t.year_description,
            t.year_level_id,
            t.semester_id,
            t.is_nstp,
            t.iscomputer_lab,
            t.islaboratory_fee
          )
          ORDER BY t.program_code ASC
          SEPARATOR '||'
        ) AS tagging_breakdown
      FROM (
        SELECT
          pt.program_tagging_id,
          pt.course_id,
          pt.year_level_id,
          pt.semester_id,
          pt.is_nstp,
          pt.iscomputer_lab,
          pt.islaboratory_fee,
          cur.program_id,
          p.program_code,
          y.year_description
        FROM program_tagging_table pt
        JOIN curriculum_table cur ON cur.curriculum_id = pt.curriculum_id
        JOIN program_table p ON p.program_id = cur.program_id
        LEFT JOIN year_table y ON y.year_id = cur.year_id
      ) t
      GROUP BY t.course_id
    ) pc ON pc.course_id = c.course_id
    ${whereSQL}
  `;

  const dataQuery = `
    SELECT
      c.course_id,
      c.course_code,
      c.course_description,
      c.prereq,
      c.corequisite,
      c.subject_type_id,
      st.subject_type_name,
      c.category_type_id,
      ct.category_type_name,
      COALESCE(pc.times_tagged, 0) AS times_tagged,
      COALESCE(pc.programs_count, 0) AS programs_count,
      pc.tagging_breakdown
    ${baseFrom}
    ORDER BY c.course_code ASC
    LIMIT ? OFFSET ?
  `;

  const countQuery = `SELECT COUNT(*) AS total ${baseFrom}`;

  try {
    const [rows] = await db3.query(dataQuery, [...params, limit, offset]);
    const [countRows] = await db3.query(countQuery, params);
    const total = countRows[0]?.total || 0;

    res.status(200).json({
      rows,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('Error fetching course tagging summary:', err);
    res.status(500).json({ error: 'Query failed', details: err.message });
  }
});

/* ------------- GET /api/course-tagging-summary/by-program/:program_id -------------
   Reverse lookup: given a program, list every course tagged into ANY of
   its curricula, with which year level / semester. Useful for e.g.
   "show me every subject tagged under BSARCHI" or checking a single
   shared subject like NSTP across all programs that use it. */
router.get('/course-tagging-summary/by-program/:program_id', async (req, res) => {
  const { program_id } = req.params;

  const query = `
    SELECT
      pt.program_tagging_id,
      pt.curriculum_id,
      pt.year_level_id,
      pt.semester_id,
      c.course_id,
      c.course_code,
      c.course_description,
      pt.is_nstp,
      pt.iscomputer_lab,
      pt.islaboratory_fee,
      pt.category,
      cur.year_id,
      y.year_description AS school_year,
      cur.lock_status
    FROM program_tagging_table pt
    JOIN course_table c ON c.course_id = pt.course_id
    JOIN curriculum_table cur ON cur.curriculum_id = pt.curriculum_id
    LEFT JOIN year_table y ON y.year_id = cur.year_id
    WHERE cur.program_id = ?
    ORDER BY pt.year_level_id ASC, pt.semester_id ASC, c.course_code ASC
  `;

  try {
    const [rows] = await db3.query(query, [program_id]);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Error fetching program tagging list:', err);
    res.status(500).json({ error: 'Query failed', details: err.message });
  }
});

/* ------------- GET /api/course-tagging-summary/:course_id/details -------------
   Every individual tagging row for one course: which program, which
   curriculum, which year level / semester it was placed in. */
router.get('/course-tagging-summary/:course_id/details', async (req, res) => {
  const { course_id } = req.params;

  const query = `
    SELECT
      pt.program_tagging_id,
      pt.curriculum_id,
      pt.year_level_id,
      pt.semester_id,
      pt.is_nstp,
      pt.iscomputer_lab,
      pt.islaboratory_fee,
      pt.category,
      cur.year_id,
      y.year_description AS school_year,
      cur.lock_status,
      p.program_id,
      p.program_code,
      p.program_description,
      p.major
    FROM program_tagging_table pt
    JOIN curriculum_table cur ON cur.curriculum_id = pt.curriculum_id
    JOIN program_table p ON p.program_id = cur.program_id
    LEFT JOIN year_table y ON y.year_id = cur.year_id
    WHERE pt.course_id = ?
    ORDER BY p.program_code ASC, pt.year_level_id ASC, pt.semester_id ASC
  `;

  try {
    const [rows] = await db3.query(query, [course_id]);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Error fetching course tagging details:', err);
    res.status(500).json({ error: 'Query failed', details: err.message });
  }
});

/* ------------- GET /api/course-tagging-summary/untagged -------------
   Convenience endpoint: courses with zero tagging rows anywhere.
   Placed AFTER the :course_id route registration order doesn't matter here
   since Express matches "/untagged" as a literal segment only if this
   route is declared before ":course_id/details" — but since that route
   requires a trailing "/details" segment, there's no collision. */
router.get('/course-tagging-summary-untagged', async (req, res) => {
  const query = `
    SELECT
      c.course_id,
      c.course_code,
      c.course_description
    FROM course_table c
    LEFT JOIN program_tagging_table pt ON pt.course_id = c.course_id
    WHERE pt.program_tagging_id IS NULL
    ORDER BY c.course_code ASC
  `;

  try {
    const [rows] = await db3.query(query);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Error fetching untagged courses:', err);
    res.status(500).json({ error: 'Query failed', details: err.message });
  }
});

module.exports = router;