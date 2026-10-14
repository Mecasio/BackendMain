const GWA_UNIT_SQL =
    "COALESCE(NULLIF(CAST(ct.course_unit AS DECIMAL(10,4)), 0), NULLIF(COALESCE(CAST(ct.lec_unit AS DECIMAL(10,4)), 0) + COALESCE(CAST(ct.lab_unit AS DECIMAL(10,4)), 0), 0), 0)";

const GWA_EXCLUSION_SQL = `
  (
    ct.is_gwa_included = 0
    OR EXISTS (
      SELECT 1
      FROM program_tagging_table ptt_ex
      LEFT JOIN year_level_table ylt_ex
        ON ylt_ex.year_level_id = ptt_ex.year_level_id
      WHERE ptt_ex.curriculum_id = es.curriculum_id
        AND ptt_ex.course_id = es.course_id
        AND (
          COALESCE(ptt_ex.is_nstp, 0) = 1
          OR COALESCE(LOWER(ylt_ex.level_type), 'year') IN ('special', 'graduate')
        )
    )
  )
`;

// Canonical grade_conversion match condition. A raw score only counts
// toward GWA if it resolves to exactly one non-disqualifying band with
// real numeric bounds and a positive score.
// esAlias/gcAlias let this be reused whether the enrolled_subject alias
// is `es` (student_grade, honors) or something else.
const gwaGradeJoinSql = (esAlias = "es", gcAlias = "gc") => `
    ${gcAlias}.is_disqualified = 0
    AND ${gcAlias}.min_score IS NOT NULL
    AND ${gcAlias}.max_score IS NOT NULL
    AND CAST(${esAlias}.final_grade AS DECIMAL(8,2)) > 0
    AND CAST(${esAlias}.final_grade AS DECIMAL(8,2))
            BETWEEN ${gcAlias}.min_score AND ${gcAlias}.max_score
`;

module.exports = { GWA_UNIT_SQL, GWA_EXCLUSION_SQL, gwaGradeJoinSql };