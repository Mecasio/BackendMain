const express = require("express");
const { db, db3 } = require("../database/database");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertSchoolYearAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

const getActorLabel = (req) => {
  const { actorId, actorRole } = getAuditActor(req);
  return {
    actorId,
    roleLabel: formatAuditActorRole(actorRole),
  };
};

const getSchoolYearLabel = async (id) => {
  const [rows] = await db3.query(
    `SELECT yt.year_description, s.semester_description
     FROM active_school_year_table sy
     JOIN year_table yt ON sy.year_id = yt.year_id
     JOIN semester_table s ON sy.semester_id = s.semester_id
     WHERE sy.id = ?
     LIMIT 1`,
    [id],
  );

  if (!rows[0]) return `school year ID ${id}`;
  return `${rows[0].year_description} ${rows[0].semester_description}`;
};

const getSchoolYearLabelFromIds = async (yearId, semesterId) => {
  const [rows] = await db3.query(
    `SELECT yt.year_description, s.semester_description
     FROM year_table yt
     JOIN semester_table s ON s.semester_id = ?
     WHERE yt.year_id = ?
     LIMIT 1`,
    [semesterId, yearId],
  );

  if (!rows[0]) return `year ID ${yearId}, semester ID ${semesterId}`;
  return `${rows[0].year_description} ${rows[0].semester_description}`;
};

const buildCurriculumStepMap = (programRows) => {
  const map = new Map();

  for (const row of programRows) {
    const curriculumId = Number(row.curriculum_id);
    if (!curriculumId || !row.year_level_id || !row.semester_id) continue;

    if (!map.has(curriculumId)) map.set(curriculumId, []);
    const steps = map.get(curriculumId);
    const exists = steps.some(
      (step) =>
        Number(step.year_level_id) === Number(row.year_level_id) &&
        Number(step.semester_id) === Number(row.semester_id),
    );

    if (!exists) {
      steps.push({
        year_level_id: Number(row.year_level_id),
        semester_id: Number(row.semester_id),
      });
    }
  }

  for (const steps of map.values()) {
    steps.sort(
      (a, b) =>
        Number(a.year_level_id) - Number(b.year_level_id) ||
        Number(a.semester_id) - Number(b.semester_id),
    );
  }

  return map;
};

const getSchoolYearTermById = async (connection, schoolYearId) => {
  const [[schoolYear]] = await connection.query(
    `
    SELECT
      sy.id,
      sy.semester_id,
      yt.year_description
    FROM active_school_year_table AS sy
    INNER JOIN year_table AS yt ON sy.year_id = yt.year_id
    WHERE sy.id = ?
    LIMIT 1
    `,
    [schoolYearId],
  );

  if (!schoolYear) return null;

  return {
    id: Number(schoolYear.id),
    semesterId: Number(schoolYear.semester_id),
    yearDescription: Number(schoolYear.year_description),
  };
};

const resetGradingPeriodToMidtermForNextSameYearSemester = async ({
  connection,
  previousActiveSchoolYear,
  selectedSchoolYear,
}) => {
  const previousYearId = Number(previousActiveSchoolYear?.year_id);
  const selectedYearId = Number(selectedSchoolYear?.year_id);
  const previousSemesterId = Number(previousActiveSchoolYear?.semester_id);
  const selectedSemesterId = Number(selectedSchoolYear?.semester_id);

  const shouldReset =
    previousYearId &&
    selectedYearId &&
    previousYearId === selectedYearId &&
    selectedSemesterId === previousSemesterId + 1;

  if (!shouldReset) {
    return { reset: false, reason: "NOT_NEXT_SAME_YEAR_SEMESTER" };
  }

  const [[midtermPeriod]] = await connection.query(
    `
    SELECT id, description, status
    FROM period_status
    WHERE LOWER(description) LIKE '%midterm%'
    LIMIT 1
    `,
  );

  if (!midtermPeriod) {
    return { reset: false, reason: "MIDTERM_PERIOD_NOT_FOUND" };
  }

  await connection.query("UPDATE period_status SET status = 0");
  await connection.query("UPDATE period_status SET status = 1 WHERE id = ?", [
    midtermPeriod.id,
  ]);

  return {
    reset: true,
    periodId: Number(midtermPeriod.id),
    periodDescription: midtermPeriod.description,
    previousSchoolYearId: Number(previousActiveSchoolYear.id),
    selectedSchoolYearId: Number(selectedSchoolYear.id),
  };
};

const getNextSchoolYearTermAfter = async (connection, previousActiveSchoolYearId) => {
  const previousSchoolYear = await getSchoolYearTermById(
    connection,
    previousActiveSchoolYearId,
  );

  if (!previousSchoolYear) return null;

  const [[nextSchoolYear]] = await connection.query(
    `
    SELECT
      sy.id,
      sy.semester_id,
      yt.year_description
    FROM active_school_year_table AS sy
    INNER JOIN year_table AS yt ON sy.year_id = yt.year_id
    WHERE (
      yt.year_description > ?
      OR (yt.year_description = ? AND sy.semester_id > ?)
    )
    ORDER BY yt.year_description ASC, sy.semester_id ASC
    LIMIT 1
    `,
    [
      previousSchoolYear.yearDescription,
      previousSchoolYear.yearDescription,
      previousSchoolYear.semesterId,
    ],
  );

  if (!nextSchoolYear) return null;

  return {
    id: Number(nextSchoolYear.id),
    semesterId: Number(nextSchoolYear.semester_id),
    yearDescription: Number(nextSchoolYear.year_description),
  };
};

const generateStudentStatusesForActivatedSchoolYear = async ({
  connection,
  targetSchoolYearId,
  targetSemesterId,
  previousActiveSchoolYearId,
}) => {
  const summary = {
    generatedRows: 0,
    skippedExistingRows: 0,
    skippedNoCurriculumSequence: 0,
    skippedNoNextStep: 0,
    skippedTargetSemesterMismatch: 0,
    generationAllowed: true,
    skippedReason: null,
    previousActiveSchoolYearId: previousActiveSchoolYearId
      ? Number(previousActiveSchoolYearId)
      : null,
    previousYearDescription: null,
    targetYearDescription: null,
    expectedNextSchoolYearId: null,
    expectedNextYearDescription: null,
  };

  const targetId = Number(targetSchoolYearId);
  const targetTerm = await getSchoolYearTermById(connection, targetId);

  if (!targetTerm) {
    summary.generationAllowed = false;
    summary.skippedReason = "TARGET_SCHOOL_YEAR_NOT_FOUND";
    return summary;
  }

  summary.targetYearDescription = targetTerm.yearDescription;

  if (previousActiveSchoolYearId) {
    const previousTerm = await getSchoolYearTermById(
      connection,
      previousActiveSchoolYearId,
    );

    if (!previousTerm) {
      summary.generationAllowed = false;
      summary.skippedReason = "PREVIOUS_ACTIVE_SCHOOL_YEAR_NOT_FOUND";
      return summary;
    }

    summary.previousYearDescription = previousTerm.yearDescription;

    if (targetTerm.yearDescription < previousTerm.yearDescription) {
      summary.generationAllowed = false;
      summary.skippedReason = "TARGET_YEAR_BEFORE_PREVIOUS_ACTIVE";
      return summary;
    }

    if (targetTerm.yearDescription > previousTerm.yearDescription + 1) {
      summary.generationAllowed = false;
      summary.skippedReason = "TARGET_YEAR_SKIPPED_AHEAD";
      return summary;
    }

    const nextTerm = await getNextSchoolYearTermAfter(
      connection,
      previousTerm.id,
    );

    summary.expectedNextSchoolYearId = nextTerm?.id || null;
    summary.expectedNextYearDescription = nextTerm?.yearDescription || null;

    if (!nextTerm || nextTerm.id !== targetId) {
      summary.generationAllowed = false;
      summary.skippedReason = nextTerm
        ? "TARGET_NOT_IMMEDIATE_NEXT_TERM"
        : "NO_NEXT_SCHOOL_YEAR_DEFINED";
      return summary;
    }
  }

  const [lockedCurricula] = await connection.query(
    "SELECT curriculum_id FROM curriculum_table WHERE lock_status = 1",
  );
  const lockedCurriculumIds = lockedCurricula
    .map((row) => Number(row.curriculum_id))
    .filter(Boolean);

  if (lockedCurriculumIds.length === 0) return summary;

  const curriculumPlaceholders = lockedCurriculumIds.map(() => "?").join(", ");
  const [programRows] = await connection.query(
    `
    SELECT curriculum_id, year_level_id, semester_id
    FROM program_tagging_table
    WHERE curriculum_id IN (${curriculumPlaceholders})
      AND year_level_id IS NOT NULL
      AND semester_id IS NOT NULL
    GROUP BY curriculum_id, year_level_id, semester_id
    ORDER BY curriculum_id, year_level_id, semester_id
    `,
    lockedCurriculumIds,
  );
  const curriculumStepMap = buildCurriculumStepMap(programRows);

  if (curriculumStepMap.size === 0) return summary;

  let studentRows = [];
  if (previousActiveSchoolYearId) {
    [studentRows] = await connection.query(
      `
      SELECT
        sst.student_number,
        sst.active_curriculum,
        sst.year_level_id,
        sst.active_school_year_id,
        asyt.semester_id
      FROM student_status_table AS sst
      INNER JOIN active_school_year_table AS asyt
        ON asyt.id = sst.active_school_year_id
      WHERE sst.active_school_year_id = ?
        AND sst.active_curriculum IN (${curriculumPlaceholders})
      `,
      [previousActiveSchoolYearId, ...lockedCurriculumIds],
    );
  } else {
    [studentRows] = await connection.query(
      `
      SELECT
        sst.student_number,
        sst.active_curriculum,
        sst.year_level_id,
        sst.active_school_year_id,
        asyt.semester_id
      FROM student_status_table AS sst
      INNER JOIN (
        SELECT student_number, MAX(id) AS latest_id
        FROM student_status_table
        WHERE active_curriculum IN (${curriculumPlaceholders})
        GROUP BY student_number
      ) AS latest
        ON latest.latest_id = sst.id
      LEFT JOIN active_school_year_table AS asyt
        ON asyt.id = sst.active_school_year_id
      `,
      lockedCurriculumIds,
    );
  }

  if (studentRows.length === 0) return summary;

  const [existingRows] = await connection.query(
    `
    SELECT student_number, active_curriculum, year_level_id
    FROM student_status_table
    WHERE active_school_year_id = ?
      AND active_curriculum IN (${curriculumPlaceholders})
    `,
    [targetSchoolYearId, ...lockedCurriculumIds],
  );
  const existingStatusKeys = new Set(
    existingRows.map(
      (row) =>
        `${row.student_number}|${Number(row.active_curriculum)}|${Number(row.year_level_id)}`,
    ),
  );

  const rowsToInsert = [];
  const plannedStatusKeys = new Set();

  for (const student of studentRows) {
    const curriculumId = Number(student.active_curriculum);
    const steps = curriculumStepMap.get(curriculumId);

    if (!steps) {
      summary.skippedNoCurriculumSequence += 1;
      continue;
    }

    const currentYearLevelId = Number(student.year_level_id || 0);
    const currentSemesterId = Number(student.semester_id || 0);
    let currentIndex = -1;

    if (currentYearLevelId && currentSemesterId) {
      currentIndex = steps.findIndex(
        (step) =>
          Number(step.year_level_id) === currentYearLevelId &&
          Number(step.semester_id) === currentSemesterId,
      );
    }

    const nextStep = currentIndex >= 0 ? steps[currentIndex + 1] : steps[0];
    if (!nextStep) {
      summary.skippedNoNextStep += 1;
      continue;
    }

    if (Number(nextStep.semester_id) !== Number(targetSemesterId)) {
      summary.skippedTargetSemesterMismatch += 1;
      continue;
    }

    const statusKey = `${student.student_number}|${curriculumId}|${Number(nextStep.year_level_id)}`;
    if (existingStatusKeys.has(statusKey) || plannedStatusKeys.has(statusKey)) {
      summary.skippedExistingRows += 1;
      continue;
    }

    plannedStatusKeys.add(statusKey);
    rowsToInsert.push([
      student.student_number,
      curriculumId,
      0,
      Number(nextStep.year_level_id),
      Number(targetSchoolYearId),
      0,
    ]);
  }

  if (rowsToInsert.length > 0) {
    await connection.query(
      `
      INSERT INTO student_status_table
        (student_number, active_curriculum, enrolled_status, year_level_id, active_school_year_id, control_status)
      VALUES ?
      `,
      [rowsToInsert],
    );
    summary.generatedRows = rowsToInsert.length;
  }

  return summary;
};

// YEAR TABLE (UPDATED!)
router.post("/years", async (req, res) => {
  const { year_description } = req.body;

  if (!year_description) {
    return res.status(400).json({ error: "year_description is required" });
  }

  const query =
    "INSERT INTO year_table (year_description, status) VALUES (?, 0)";

  try {
    const [result] = await db3.query(query, [year_description]);
    const { actorId, roleLabel } = getActorLabel(req);
    await insertSchoolYearAuditLog({
      req,
      action: "YEAR_CREATE",
      message: `${roleLabel} (${actorId}) created year ${year_description}.`,
    });

    res.status(201).json({
      year_id: result.insertId,
      year_description,
      status: 0,
    });
  } catch (err) {
    console.error("Insert error:", err);
    res.status(500).json({
      error: "Insert failed",
      details: err.message,
    });
  }
});

// YEAR LIST (UPDATED!)
router.get("/year_table", async (req, res) => {
  const query = "SELECT * FROM year_table";

  try {
    const [result] = await db3.query(query);
    res.status(200).json(result);
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({
      error: "Query failed",
      details: err.message,
    });
  }
});

router.put("/year_table/:id", async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  try {
    const [[year]] = await db3.query(
      "SELECT year_description FROM year_table WHERE year_id = ? LIMIT 1",
      [id],
    );

    if (status === 1) {
      // Deactivate all other years first
      const deactivateQuery = "UPDATE year_table SET status = 0";
      await db3.query(deactivateQuery);

      // Activate the selected year
      const activateQuery =
        "UPDATE year_table SET status = 1 WHERE year_id = ?";
      await db3.query(activateQuery, [id]);

      // Activate the selected year's 1st semester school year only
      await db3.query("UPDATE active_school_year_table SET astatus = 0");
      await db3.query(
        "UPDATE active_school_year_table SET astatus = 1 WHERE year_id = ? AND semester_id = 1",
        [id],
      );

      const { actorId, roleLabel } = getActorLabel(req);
      await insertSchoolYearAuditLog({
        req,
        action: "YEAR_STATUS_UPDATE",
        message: `${roleLabel} (${actorId}) activated year ${year?.year_description || id}.`,
      });

      res.status(200).json({ message: "Year status updated successfully" });
    } else {
      // Deactivate the selected year
      const updateQuery = "UPDATE year_table SET status = 0 WHERE year_id = ?";
      await db3.query(updateQuery, [id]);

      // Deactivate all school years for this year
      await db3.query(
        "UPDATE active_school_year_table SET astatus = 0 WHERE year_id = ?",
        [id],
      );

      const { actorId, roleLabel } = getActorLabel(req);
      await insertSchoolYearAuditLog({
        req,
        action: "YEAR_STATUS_UPDATE",
        message: `${roleLabel} (${actorId}) deactivated year ${year?.year_description || id}.`,
      });

      res.status(200).json({ message: "Year deactivated successfully" });
    }
  } catch (err) {
    console.error("Error updating year status:", err);
    res.status(500).json({
      error: "Failed to update year status",
      details: err.message,
    });
  }
});


router.post("/semesters", async (req, res) => {
  const { semester_description, semester_code, ordinal_label } = req.body;

  if (!semester_description || !semester_code) {
    return res.status(400).json({ error: "missing fields is required" });
  }

  const query = "INSERT INTO semester_table (semester_description, semester_code, ordinal_label) VALUES (?, ?, ?)";

  try {
    const [result] = await db3.query(query, [semester_description, semester_code, ordinal_label || null]);
    const { actorId, roleLabel } = getActorLabel(req);
    await insertSchoolYearAuditLog({
      req,
      action: "SEMESTER_CREATE",
      message: `${roleLabel} (${actorId}) created semester ${semester_description} (${semester_code}).`,
    });

    res.status(201).json({
      semester_id: result.insertId,
      semester_description,
      semester_code,
      ordinal_label,
    });
  } catch (err) {
    console.error("Insert error:", err);
    res.status(500).json({ error: "Insert failed", details: err.message });
  }
});

router.put("/semesters/:id", async (req, res) => {
  const { semester_description, semester_code, ordinal_label } = req.body;
  const { id } = req.params;

  if (!semester_description || !semester_code) {
    return res.status(400).json({ error: "missing fields is required" });
  }

  const query = `
    UPDATE semester_table
    SET semester_description = ?, semester_code = ?, ordinal_label = ?
    WHERE semester_id = ?
  `;

  try {
    const [result] = await db3.query(query, [
      semester_description,
      semester_code,
      ordinal_label || null,
      id,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Semester not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertSchoolYearAuditLog({
      req,
      action: "SEMESTER_UPDATE",
      message: `${roleLabel} (${actorId}) updated semester ${semester_description} (${semester_code}).`,
    });

    res.status(200).json({
      message: "Semester updated successfully",
      semester_id: Number(id),
      semester_description,
      semester_code,
      ordinal_label,
    });
  } catch (err) {
    console.error("Update semester error:", err);
    res.status(500).json({ error: "Update failed", details: err.message });
  }
});


router.get("/summer-school-year-context", async (req, res) => {
  try {
    const query = `
      SELECT
        asyt.id AS school_year_id,
        asyt.year_id,
        asyt.semester_id,
        yt.year_description AS current_year,
        yt.year_description + 1 AS next_year,
        st.semester_description
      FROM active_school_year_table AS asyt
      INNER JOIN year_table AS yt ON asyt.year_id = yt.year_id
      INNER JOIN semester_table AS st ON asyt.semester_id = st.semester_id
      WHERE asyt.year_id = (
        SELECT year_id
        FROM active_school_year_table
        WHERE astatus = 1
        LIMIT 1
      )
        AND LOWER(st.semester_description) LIKE '%summer%'
      ORDER BY asyt.id DESC
      LIMIT 1
    `;
    const [result] = await db3.query(query);
    res.json(result[0] || null);
  } catch (err) {
    console.error("Summer school-year context query error:", err);
    res.status(500).json({ error: "Failed to load Summer school-year context" });
  }
});

router.get("/get_semester", async (req, res) => {
  const query = "SELECT * FROM semester_table";

  try {
    const [result] = await db3.query(query);
    res.status(200).json(result);
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({ error: "Query failed", details: err.message });
  }
});

router.delete("/semesters/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [[semester]] = await db3.query(
      "SELECT semester_description, semester_code FROM semester_table WHERE semester_id = ? LIMIT 1",
      [id],
    );

    const [result] = await db3.query(
      "DELETE FROM semester_table WHERE semester_id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Semester not found" });
    }

    const semesterLabel = semester
      ? `${semester.semester_description} (${semester.semester_code})`
      : `semester ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertSchoolYearAuditLog({
      req,
      action: "SEMESTER_DELETE",
      message: `${roleLabel} (${actorId}) deleted ${semesterLabel}.`,
    });

    res.status(200).json({ message: "Semester deleted successfully" });
  } catch (err) {
    console.error("Delete semester error:", err);
    res.status(500).json({ error: "Delete failed", details: err.message });
  }
});

router.get("/school_years", async (req, res) => {
  const query = `
    SELECT sy.*, yt.year_description, s.semester_description
    FROM active_school_year_table sy
    JOIN year_table yt ON sy.year_id = yt.year_id
    JOIN semester_table s ON sy.semester_id = s.semester_id
    ORDER BY yt.year_description
  `;

  try {
    const [result] = await db3.query(query);
    res.status(200).json(result);
  } catch (err) {
    console.error("Fetch error:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch school years", details: err.message });
  }
});

router.post("/school_years", CanCreate, async (req, res) => {
  const { year_id, semester_id, activator } = req.body;

  if (!year_id || !semester_id) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // Check if the school year already exists
    const checkQuery = `
      SELECT * FROM active_school_year_table
      WHERE year_id = ? AND semester_id = ?
    `;
    const [existing] = await db3.query(checkQuery, [year_id, semester_id]);

    if (existing.length > 0) {
      return res.status(400).json({ error: "This school year already exists" });
    }

    // Insert if not exists
    const insertQuery = `
      INSERT INTO active_school_year_table (year_id, semester_id, astatus, active)
      VALUES (?, ?, ?, 0)
    `;
    const [result] = await db3.query(insertQuery, [
      year_id,
      semester_id,
      activator,
    ]);

    const schoolYearLabel = await getSchoolYearLabelFromIds(year_id, semester_id);
    const { actorId, roleLabel } = getActorLabel(req);
    await insertSchoolYearAuditLog({
      req,
      action: "SCHOOL_YEAR_CREATE",
      message: `${roleLabel} (${actorId}) created school year ${schoolYearLabel}.`,
    });

    res.status(201).json({ school_year_id: result.insertId });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({
      error: "Failed to process the school year",
      details: err.message,
    });
  }
});

router.put("/school_years/deactivate_all", async (req, res) => {
  try {
    await db3.query("UPDATE active_school_year_table SET astatus = 0");
    res.status(200).json({ message: "All school years deactivated" });
  } catch (err) {
    console.error("Error deactivating school years:", err);
    res.status(500).json({
      error: "Failed to deactivate school years",
      details: err.message,
    });
  }
});

router.put("/school_years/:id", async (req, res) => {
  const { id } = req.params;
  const { activator } = req.body;
  let connection;

  try {
    const schoolYearLabel = await getSchoolYearLabel(id);
    const [yearRows] = await db3.query(
      "SELECT id, year_id, semester_id FROM active_school_year_table WHERE id = ? LIMIT 1",
      [id],
    );
    const selectedSchoolYear = yearRows[0];

    if (!selectedSchoolYear) {
      return res.status(404).json({ error: "School year not found" });
    }

    const yearId = selectedSchoolYear.year_id;

    if (parseInt(activator) === 1) {
      connection = await db3.getConnection();
      await connection.beginTransaction();

      const [previousActiveRows] = await connection.query(
        "SELECT id, year_id, semester_id FROM active_school_year_table WHERE astatus = 1 AND id != ? LIMIT 1",
        [id],
      );
      const previousActiveSchoolYear = previousActiveRows[0] || null;
      const previousActiveSchoolYearId = previousActiveSchoolYear?.id || null;

      await connection.query("UPDATE active_school_year_table SET astatus = 0");

      // Activate selected
      await connection.query(
        "UPDATE active_school_year_table SET astatus = 1 WHERE id = ?",
        [id],
      );

      if (yearId) {
        await connection.query("UPDATE year_table SET status = 0");
        await connection.query("UPDATE year_table SET status = 1 WHERE year_id = ?", [
          yearId,
        ]);
      }

      const studentStatusGeneration = await generateStudentStatusesForActivatedSchoolYear({
        connection,
        targetSchoolYearId: id,
        targetSemesterId: selectedSchoolYear.semester_id,
        previousActiveSchoolYearId,
      });

      const gradingPeriodReset = await resetGradingPeriodToMidtermForNextSameYearSemester({
        connection,
        previousActiveSchoolYear,
        selectedSchoolYear,
      });

      await connection.commit();
      connection.release();
      connection = null;

      await db.query(
        "UPDATE user_accounts SET status = 0 WHERE school_year_id IS NOT NULL AND school_year_id != ?",
        [id],
      );

      await db.query(
        "UPDATE user_accounts SET status = 1 WHERE school_year_id = ?",
        [id],
      );

      const { actorId, roleLabel } = getActorLabel(req);
      await insertSchoolYearAuditLog({
        req,
        action: "SCHOOL_YEAR_ACTIVATE",
        message: `${roleLabel} (${actorId}) activated school year ${schoolYearLabel}.`,
      });

      return res.status(200).json({
        message: "School year activated",
        studentStatusGeneration,
        gradingPeriodReset,
      });
    } else {
      connection = await db3.getConnection();
      await connection.beginTransaction();

      // Deactivate selected
      await connection.query(
        "UPDATE active_school_year_table SET astatus = 0 WHERE id = ?",
        [id],
      );

      await db.query(
        "UPDATE user_accounts SET status = 0 WHERE school_year_id IS NOT NULL AND school_year_id != ?",
        [id],
      );

      // Unenroll all students tied to the deactivated school year
      await connection.query(
        "UPDATE student_status_table SET enrolled_status = 0 WHERE active_school_year_id = ?",
        [id],
      );

      if (yearId) {
        await connection.query("UPDATE year_table SET status = 0 WHERE year_id = ?", [
          yearId,
        ]);
      }

      await connection.commit();
      connection.release();
      connection = null;

      const { actorId, roleLabel } = getActorLabel(req);
      await insertSchoolYearAuditLog({
        req,
        action: "SCHOOL_YEAR_DEACTIVATE",
        message: `${roleLabel} (${actorId}) deactivated school year ${schoolYearLabel}.`,
      });

      return res.status(200).json({ message: "School year deactivated" });
    }
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
        connection.release();
      } catch (rollbackErr) {
        console.error("Rollback error:", rollbackErr);
      }
    }
    console.error("Error:", err);
    res
      .status(500)
      .json({ error: "Failed to update school year", details: err.message });
  }
});

router.put("/edit_school_years/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { year_id, semester_id } = req.body;

  if (!year_id || !semester_id) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const previousSchoolYearLabel = await getSchoolYearLabel(id);
    const [currentRows] = await db3.query(
      "SELECT * FROM active_school_year_table WHERE id = ? LIMIT 1",
      [id],
    );

    if (currentRows.length === 0) {
      return res.status(404).json({ error: "School year not found" });
    }

    const [existing] = await db3.query(
      `
        SELECT id
        FROM active_school_year_table
        WHERE year_id = ? AND semester_id = ? AND id != ?
      `,
      [year_id, semester_id, id],
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: "This school year already exists" });
    }

    await db3.query(
      `
        UPDATE active_school_year_table
        SET year_id = ?, semester_id = ?
        WHERE id = ?
      `,
      [year_id, semester_id, id],
    );

    const newSchoolYearLabel = await getSchoolYearLabelFromIds(year_id, semester_id);
    const { actorId, roleLabel } = getActorLabel(req);
    await insertSchoolYearAuditLog({
      req,
      action: "SCHOOL_YEAR_UPDATE",
      message: `${roleLabel} (${actorId}) updated school year ${previousSchoolYearLabel} to ${newSchoolYearLabel}.`,
    });

    res.status(200).json({ message: "School year updated successfully" });
  } catch (err) {
    console.error("Error:", err);
    res
      .status(500)
      .json({ error: "Failed to update school year", details: err.message });
  }
});

router.delete("/school_years/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const schoolYearLabel = await getSchoolYearLabel(id);
    const deleteQuery = "DELETE FROM active_school_year_table WHERE id = ?";
    const [result] = await db3.query(deleteQuery, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "School year not found" });
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertSchoolYearAuditLog({
      req,
      action: "SCHOOL_YEAR_DELETE",
      message: `${roleLabel} (${actorId}) deleted school year ${schoolYearLabel}.`,
    });

    res.status(200).json({ message: "School year deleted successfully" });
  } catch (err) {
    console.error("Error deleting school year:", err);
    res
      .status(500)
      .json({ error: "Failed to delete school year", details: err.message });
  }
});

router.get("/get_school_year", async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT
        year_id,
        year_description AS current_year,
        year_description + 1 AS next_year
      FROM year_table ORDER BY current_year;
    `;
    const [result] = await db3.query(query);
    res.json(result);
  } catch (err) {
    console.error("Server Error: ", err);
    res.status(500).send({ message: "Internal Error", err });
  }
});

router.get("/get_school_semester", async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT
        semester_id,semester_description, semester_code
      FROM semester_table ORDER BY semester_code;
    `;
    const [result] = await db3.query(query);
    res.json(result);
  } catch (err) {
    console.error("Server Error: ", err);
    res.status(500).send({ message: "Internal Error", err });
  }
});

router.get("/get_selected_year/:yearId/:semesterId", async (req, res) => {
  const { yearId, semesterId } = req.params;

  if (!yearId || !semesterId) {
    return res.status(400).json({
      message: "School year and semester are required",
    });
  }

  try {
    const [result] = await db3.query(
      `SELECT id AS school_year_id, year_id, semester_id
       FROM active_school_year_table
       WHERE year_id = ? AND semester_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [yearId, semesterId],
    );

    res.json(result);
  } catch (err) {
    console.error("Error resolving selected school year:", err);
    res.status(500).json({ message: "Failed to resolve selected school year" });
  }
});

router.get("/active_school_year", async (req, res) => {
  try {
    const query = `
    SELECT
    asyt.id AS school_year_id,
    yt.year_id,
    st.semester_id,
    yt.year_description AS current_year,
    yt.year_description + 1 AS next_year,
    st.semester_description
  FROM active_school_year_table AS asyt
    INNER JOIN year_table AS yt ON asyt.year_id = yt.year_id
    INNER JOIN semester_table AS st ON asyt.semester_id = st.semester_id
  WHERE asyt.astatus = 1
    `;
    const [result] = await db3.query(query);
    res.json(result);
    console.log(result);
  } catch (err) {
    console.error("Server Error: ", err);
    res.status(500).send({ message: "Internal Error", err });
  }
});

router.get("/active_school_year_by_id/:id", async (req, res) => {
  try {
    const query = `
      SELECT
        asyt.id,
        asyt.id AS school_year_id,
        asyt.year_id,
        asyt.semester_id,
        asyt.astatus,
        yt.year_description,
        yt.year_description AS current_year,
        yt.year_description + 1 AS next_year,
        st.semester_description
      FROM active_school_year_table AS asyt
      INNER JOIN year_table AS yt ON asyt.year_id = yt.year_id
      INNER JOIN semester_table AS st ON asyt.semester_id = st.semester_id
      WHERE asyt.id = ?
      LIMIT 1
    `;
    const [result] = await db3.query(query, [req.params.id]);
    res.json(result);
  } catch (err) {
    console.error("Server Error: ", err);
    res.status(500).send({ message: "Internal Error", err });
  }
});

router.get("/get_selecterd_year/:selectedSchoolYear/:selectedSchoolSemester", async (req, res) => {
    const { selectedSchoolYear, selectedSchoolSemester } = req.params;
    try {
      const query = `
    SELECT
    asyt.id AS school_year_id,
    asyt.id,
    asyt.year_id,
    asyt.semester_id,
    yt.year_description,
    yt.year_description AS current_year,
    yt.year_description + 1 AS next_year,
    st.semester_description
  FROM active_school_year_table AS asyt
    INNER JOIN year_table AS yt ON asyt.year_id = yt.year_id
    INNER JOIN semester_table AS st ON asyt.semester_id = st.semester_id
  WHERE yt.year_id = ? AND st.semester_id = ?
    `;
      const [result] = await db3.query(query, [
        selectedSchoolYear,
        selectedSchoolSemester,
      ]);
      console.log(result);
      res.json(result);
    } catch (err) {
      console.error("Server Error: ", err);
      res.status(500).send({ message: "Internal Error", err });
    }
  },
);

router.get("/get_active_school_years", async (req, res) => {
  const query = `
    SELECT sy.*, yt.year_description, s.semester_description
    FROM active_school_year_table sy
    JOIN year_table yt ON sy.year_id = yt.year_id
    JOIN semester_table s ON sy.semester_id = s.semester_id
    WHERE sy.astatus = 1
  `;

  try {
    const [result] = await db3.query(query);
    res.status(200).json(result);
  } catch (err) {
    console.error("Fetch error:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch school years", details: err.message });
  }
});

// GET all school years
router.get("/school-years", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT year_id, year_description, status
      FROM year_table
      ORDER BY year_description DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("Error fetching school years:", err);
    res.status(500).json({ message: "Failed to fetch school years" });
  }
});

router.get("/year_table", async (req, res) => {
  try {
    const [rows] = await db3.query(
      `SELECT * FROM year_table ORDER BY year_description DESC`,
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching year_table:", error);
    res.status(500).json({ message: "Database error" });
  }
});

router.get("/semester_table", async (req, res) => {
  try {
    const [rows] = await db3.query(`SELECT * FROM semester_table`);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching semester_table:", error);
    res.status(500).json({ message: "Database error" });
  }
});

module.exports = router
