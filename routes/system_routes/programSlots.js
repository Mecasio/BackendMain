const express = require("express");
const {
  db,
  db3,
  ensureProgramSlotsEStatusColumn,
} = require("../database/database");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();

// Ensure e_status exists once (default 0 = visible in course selection)
ensureProgramSlotsEStatusColumn().catch((err) => {
  console.error("Failed to ensure program_slots.e_status column:", err);
});

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertProgramSlotAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

const getProgramSlotLabel = async (curriculumId) => {
  const [rows] = await db3.query(
    `SELECT p.program_code, p.program_description, p.major
     FROM curriculum_table ct
     LEFT JOIN program_table p ON p.program_id = ct.program_id
     WHERE ct.curriculum_id = ?
     LIMIT 1`,
    [curriculumId],
  );

  const program = rows?.[0];
  if (!program) return `Curriculum ${curriculumId}`;

  return `${program.program_code || "N/A"} - ${program.program_description || "Unknown Program"}${program.major ? ` (${program.major})` : ""}`;
};

const formatPersonName = (row = {}) => {
  const name = [row.first_name, row.middle_name, row.last_name]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return name || row.email || "Unknown Employee";
};

const getActorAuditLabel = async (req) => {
  const { actorId, actorRole } = getAuditActor(req);
  const roleLabel = formatAuditActorRole(actorRole);

  try {
    const [rows] = await db3.query(
      `SELECT ua.employee_id, ua.first_name, ua.middle_name, ua.last_name, ua.email,
              at.access_description
       FROM user_accounts ua
       LEFT JOIN access_table at ON at.access_id = ua.access_level
       WHERE ua.employee_id = ?
          OR ua.person_id = ?
          OR ua.email = ?
       LIMIT 1`,
      [actorId, actorId, actorId],
    );

    if (rows?.[0]) {
      const accessLabel = String(rows[0].access_description || "").trim();
      return `${accessLabel || roleLabel} ${formatPersonName(rows[0])} (${rows[0].employee_id || actorId})`;
    }
  } catch (err) {
    console.error("Program slot actor audit lookup failed:", err);
  }

  return `${roleLabel} (${actorId})`;
};

const getSchoolTermLabel = async (activeSchoolYearId) => {
  try {
    const [rows] = await db3.query(
      `SELECT yt.year_description, sem.semester_description
       FROM active_school_year_table asy
       LEFT JOIN year_table yt ON yt.year_id = asy.year_id
       LEFT JOIN semester_table sem ON sem.semester_id = asy.semester_id
       WHERE asy.id = ?
       LIMIT 1`,
      [activeSchoolYearId],
    );

    const term = rows?.[0];
    if (!term) return `active school year ID ${activeSchoolYearId}`;

    const schoolYear = term.year_description || `school year ID ${activeSchoolYearId}`;
    const semester = term.semester_description
      ? `, ${term.semester_description}`
      : "";

    return `${schoolYear}${semester}`;
  } catch (err) {
    console.error("Program slot school term audit lookup failed:", err);
    return `active school year ID ${activeSchoolYearId}`;
  }
};

const getDepartmentLabel = async (departmentId) => {
  try {
    const [rows] = await db3.query(
      `SELECT dprtmnt_name, dprtmnt_code
       FROM dprtmnt_table
       WHERE dprtmnt_id = ?
       LIMIT 1`,
      [departmentId],
    );

    const department = rows?.[0];
    if (!department) return `department ID ${departmentId}`;

    return `${department.dprtmnt_name || "Unknown Department"}${department.dprtmnt_code ? ` (${department.dprtmnt_code})` : ""}`;
  } catch (err) {
    console.error("Program slot department audit lookup failed:", err);
    return `department ID ${departmentId}`;
  }
};

const memoryCache = {
  data: new Map(),
  set(key, value, ttlMs = 80000) {
    // 3 min default
    this.data.set(key, {
      value,
      expires: Date.now() + ttlMs,
    });
  },
  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  },
  clear() {
    this.data.clear();
  },
};

setInterval(() => {
  const now = Date.now();
  for (const [key, item] of memoryCache.data.entries()) {
    if (now > item.expires) {
      memoryCache.data.delete(key);
    }
  }
}, 1000000);

router.get("/programs/availability", async (req, res) => {
  try {
    // Payment save routes update matriculation/UNIFAST outside this module, so
    // keep availability live instead of serving stale slot counts from cache.

    // Parallel query execution
    const [activeResult, programsResult] = await Promise.all([
      db3.query(
        "SELECT id FROM active_school_year_table WHERE astatus = 1 LIMIT 1",
      ),
      db3.query(`
        SELECT DISTINCT
          dc.dprtmnt_curriculum_id,
          dc.dprtmnt_id,
          dc.curriculum_id,
          dt.dprtmnt_name,
          dt.dprtmnt_code,
          ct.year_id,
          y.year_description,
          ct.program_id,
          p.program_description,
          p.program_code,
          p.major,
          p.components
        FROM dprtmnt_curriculum_table dc
        INNER JOIN dprtmnt_table dt ON dc.dprtmnt_id = dt.dprtmnt_id
        INNER JOIN curriculum_table ct ON dc.curriculum_id = ct.curriculum_id
        INNER JOIN program_table p ON ct.program_id = p.program_id
        INNER JOIN year_table y ON ct.year_id = y.year_id
        WHERE ct.lock_status = 1
        ORDER BY dt.dprtmnt_name, p.program_description
      `),
    ]);

    const activeSchoolYearId = activeResult[0][0]?.id;

    if (!activeSchoolYearId) {
      return res.json([]);
    }

    const programs = programsResult[0];

    if (programs.length === 0) {
      return res.json([]);
    }

    // Extract curriculum IDs efficiently
    const curriculumIds = programs.map((p) => p.curriculum_id);

    // Parallel fetch slots and official enrollment data.
    // A first-year student is officially enrolled once saved to either
    // matriculation or UNIFAST for this active school year.
    await ensureProgramSlotsEStatusColumn();

    const [slotsResult, enrollmentResult] = await Promise.all([
      db.query(
        `SELECT curriculum_id, max_slots, active_school_year_id, e_status
         FROM program_slots 
         WHERE curriculum_id IN (?) AND active_school_year_id = ?`,
        [curriculumIds, activeSchoolYearId],
      ),
      db3.query(
        `SELECT DISTINCT
           sts.active_curriculum AS curriculum_id,
           COUNT(DISTINCT sts.student_number) AS total_enrolled
         FROM enrollment.student_status_table sts
         WHERE sts.active_curriculum IN (?)
           AND sts.active_school_year_id = ?
           AND sts.year_level_id = 1
           AND (
             EXISTS (
               SELECT 1
               FROM enrollment.matriculation m
               WHERE m.student_number = sts.student_number
                 AND m.active_school_year_id = sts.active_school_year_id
                 AND m.status = 1
             )
             OR EXISTS (
               SELECT 1
               FROM enrollment.unifast u
               WHERE u.student_number = sts.student_number
                 AND u.active_school_year_id = sts.active_school_year_id
                 AND u.status = 1
             )
           )
         GROUP BY sts.active_curriculum`,
        [curriculumIds, activeSchoolYearId],
      ),
    ]);

    const slots = slotsResult[0];
    const enrollment = enrollmentResult[0];

    // Build lookup objects (faster than Map for small datasets, no extra dependency)
    const slotsLookup = {};
    for (let i = 0; i < slots.length; i++) {
      slotsLookup[slots[i].curriculum_id] = slots[i];
    }

    const enrollmentLookup = {};
    for (let i = 0; i < enrollment.length; i++) {
      enrollmentLookup[enrollment[i].curriculum_id] = Number(
        enrollment[i].total_enrolled,
      );
    }

    // Merge data efficiently using plain object spread
    const results = new Array(programs.length);
    for (let i = 0; i < programs.length; i++) {
      const p = programs[i];
      const slot = slotsLookup[p.curriculum_id];
      const maxSlots = slot?.max_slots || 0;
      const totalEnrolled = enrollmentLookup[p.curriculum_id] || 0;

      results[i] = {
        dprtmnt_curriculum_id: p.dprtmnt_curriculum_id,
        dprtmnt_id: p.dprtmnt_id,
        curriculum_id: p.curriculum_id,
        dprtmnt_name: p.dprtmnt_name,
        dprtmnt_code: p.dprtmnt_code,
        ct_curriculum_id: p.curriculum_id,
        year_id: p.year_id,
        year_description: p.year_description,
        program_id: p.program_id,
        lock_status: 1,
        program_description: p.program_description,
        program_code: p.program_code,
        major: p.major,
        components: p.components,
        active_school_year_id:
          slot?.active_school_year_id || activeSchoolYearId,
        max_slots: maxSlots,
        e_status: Number(slot?.e_status ?? 0),
        total_enrolled: totalEnrolled,
        remaining: maxSlots - totalEnrolled > 0 ? maxSlots - totalEnrolled : 0,
      };
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch program availability" });
  }
});

router.get("/program-slots/history", async (req, res) => {
  const { curriculum_id, year_id, semester_id } = req.query;

  if (!curriculum_id || !year_id || !semester_id) {
    return res.status(400).json({
      message: "curriculum_id, year_id, and semester_id are required",
    });
  }

  try {
    const [[activeYear]] = await db3.query(
      `SELECT id
       FROM active_school_year_table
       WHERE year_id = ? AND semester_id = ?
       LIMIT 1`,
      [year_id, semester_id],
    );

    if (!activeYear) {
      return res.status(200).json([]);
    }

    const curriculumMarker = `[curriculum_id:${curriculum_id}]`;
    const termMarker = `[active_school_year_id:${activeYear.id}]`;
    const [rows] = await db.query(
      `SELECT audit_id, actor_id, role, message, timestamp
       FROM audit_logs
       WHERE action IN (
         'PROGRAM_SLOT_CREATE',
         'PROGRAM_SLOT_ADD',
         'PROGRAM_SLOT_DEPARTMENT_ADD',
         'PROGRAM_SLOT_ALL_ADD'
       )
         AND message LIKE ?
         AND message LIKE ?
       ORDER BY timestamp DESC, audit_id DESC
       LIMIT 50`,
      [`%${curriculumMarker}%`, `%${termMarker}%`],
    );

    const actorIds = [...new Set(rows.map((row) => row.actor_id).filter(Boolean))];
    const actorLookup = new Map();

    if (actorIds.length > 0) {
      const [actors] = await db3.query(
        `SELECT employee_id, person_id, email, first_name, middle_name, last_name
         FROM user_accounts
         WHERE employee_id IN (?) OR person_id IN (?) OR email IN (?)`,
        [actorIds, actorIds, actorIds],
      );

      actors.forEach((actor) => {
        const actorName = formatPersonName(actor);
        [actor.employee_id, actor.person_id, actor.email]
          .filter(Boolean)
          .forEach((key) => actorLookup.set(String(key), actorName));
      });
    }

    const history = rows.map((row) => {
      const values = row.message.match(
        /from\s+(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)\s+\(added\s+(-?\d+(?:\.\d+)?)\)/i,
      );

      return {
        audit_id: row.audit_id,
        previous_slots: values ? Number(values[1]) : null,
        current_slots: values ? Number(values[2]) : null,
        added_slots: values ? Number(values[3]) : null,
        actor_id: row.actor_id,
        actor_role: row.role,
        actor_name: actorLookup.get(String(row.actor_id)) || null,
        timestamp: row.timestamp,
      };
    });

    return res.status(200).json(history);
  } catch (err) {
    console.error("Error fetching program slot history:", err);
    return res.status(500).json({ message: "Failed to fetch program slot history" });
  }
});

router.post("/apply", async (req, res) => {
  console.log("apply route body:", req.body);
  const { curriculum_id, year_id, person_id } = req.body;

  // Use db pool instead of undefined pool
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Prevent double application
    const [[alreadyapplied]] = await connection.query(
      `
  SELECT program
  FROM admission.person_table
  WHERE person_id = ?
    AND program IS NOT NULL
`,
      [person_id],
    );

    if (alreadyapplied) {
      await connection.rollback();
      return res.json({
        message: "You have already applied to a program",
        alreadyapplied: true,
        curriculum_id: alreadyapplied.program, // optional
      });
    }

    // Lock slot row
    const [[slot]] = await connection.query(
      `
      SELECT 
        ps.max_slots,
        COUNT(DISTINCT pt.person_id) AS used_slots
      FROM enrollment.curriculum_table c
      JOIN admission.program_slots ps
        ON ps.curriculum_id = c.curriculum_id
      LEFT JOIN admission.person_table pt
        ON pt.program = c.curriculum_id
      WHERE c.curriculum_id = ?
      FOR UPDATE
    `,
      [curriculum_id],
    );

    if (!slot) {
      await connection.rollback();
      return res.status(400).json({
        message: "Program slot not configured",
      });
    }

    if (slot.used_slots >= slot.max_slots) {
      await connection.rollback();
      return res.status(403).json({
        message: "This program is already full",
      });
    }

    // Assign program
    await connection.query(
      `
      UPDATE admission.person_table
      SET program = ?
      WHERE person_id = ?
    `,
      [curriculum_id, person_id],
    );

    await connection.commit();
    res.json({ message: "application submitted successfully" });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ message: "application failed" });
  } finally {
    connection.release();
  }
});

router.post("/program-slots", async (req, res) => {
  const { curriculum_id, max_slots, year_id, semester_id } = req.body;
  const slotValue = Number(max_slots);

  if (
    !curriculum_id ||
    !year_id ||
    !semester_id ||
    !Number.isInteger(slotValue) ||
    slotValue < 1
  ) {
    return res.status(400).json({ message: "Missing or invalid required fields" });
  }

  try {
    const [activeRows] = await db3.query(
      "SELECT id FROM active_school_year_table WHERE year_id = ? AND semester_id = ? LIMIT 1",
      [year_id, semester_id],
    );
    const activeSchoolYearId = activeRows[0]?.id;

    if (!activeSchoolYearId) {
      return res
        .status(400)
        .json({ message: "Active school year not found for selection" });
    }

    // check if already exists
    const [[existing]] = await db.query(
      `
      SELECT slot_id, max_slots
      FROM admission.program_slots
      WHERE curriculum_id = ? AND active_school_year_id = ?
    `,
      [curriculum_id, activeSchoolYearId],
    );

    if (existing) {
      const previousTotalSlots = Number(existing.max_slots || 0);
      const newTotalSlots = Number(existing.max_slots || 0) + slotValue;

      await db.query(
        `
        UPDATE admission.program_slots
        SET max_slots = max_slots + ?
        WHERE curriculum_id = ? AND active_school_year_id = ?
      `,
        [slotValue, curriculum_id, activeSchoolYearId],
      );

      const actorLabel = await getActorAuditLabel(req);
      const programLabel = await getProgramSlotLabel(curriculum_id);
      const schoolTermLabel = await getSchoolTermLabel(activeSchoolYearId);
      await insertProgramSlotAuditLog({
        req,
        action: "PROGRAM_SLOT_ADD",
        message:
          `${actorLabel} added slots to ${programLabel} for ${schoolTermLabel} ` +
          `from ${previousTotalSlots} to ${newTotalSlots} (added ${slotValue}). ` +
          `[curriculum_id:${curriculum_id}] [active_school_year_id:${activeSchoolYearId}]`,
      });

      memoryCache.clear();
      return res.json({ message: "Program slots added" });
    }

    // INSERT
    await db.query(
      `
      INSERT INTO admission.program_slots
      (curriculum_id, max_slots, active_school_year_id, created_at)
      VALUES (?, ?, ?, NOW())
    `,
      [curriculum_id, slotValue, activeSchoolYearId],
    );

    const actorLabel = await getActorAuditLabel(req);
    const programLabel = await getProgramSlotLabel(curriculum_id);
    const schoolTermLabel = await getSchoolTermLabel(activeSchoolYearId);
    await insertProgramSlotAuditLog({
      req,
      action: "PROGRAM_SLOT_CREATE",
      message:
        `${actorLabel} created program slot limit for ${programLabel} for ${schoolTermLabel} ` +
        `from 0 to ${slotValue} (added ${slotValue}). ` +
        `[curriculum_id:${curriculum_id}] [active_school_year_id:${activeSchoolYearId}]`,
    });

    memoryCache.clear();
    res.json({ message: "Program slots created" });
  } catch (err) {
    console.error("Error saving program slots:", err);
    res.status(500).json({ message: "Failed to save program slots" });
  }
});

router.post("/program-slots/add", async (req, res) => {
  const { curriculum_id, add_slots, year_id, semester_id } = req.body;
  const slotsToAdd = Number(add_slots);

  if (
    !curriculum_id ||
    !year_id ||
    !semester_id ||
    !Number.isInteger(slotsToAdd) ||
    slotsToAdd < 1
  ) {
    return res.status(400).json({ message: "Missing or invalid required fields" });
  }

  const connection = await db.getConnection();

  try {
    const [activeRows] = await db3.query(
      "SELECT id FROM active_school_year_table WHERE year_id = ? AND semester_id = ? LIMIT 1",
      [year_id, semester_id],
    );
    const activeSchoolYearId = activeRows[0]?.id;

    if (!activeSchoolYearId) {
      return res
        .status(400)
        .json({ message: "Active school year not found for selection" });
    }

    await connection.beginTransaction();

    const [[existing]] = await connection.query(
      `
      SELECT slot_id, max_slots
      FROM admission.program_slots
      WHERE curriculum_id = ? AND active_school_year_id = ?
      FOR UPDATE
    `,
      [curriculum_id, activeSchoolYearId],
    );

    const previousTotalSlots = Number(existing?.max_slots || 0);
    let newTotalSlots = slotsToAdd;

    if (existing) {
      newTotalSlots = Number(existing.max_slots || 0) + slotsToAdd;
      await connection.query(
        `
        UPDATE admission.program_slots
        SET max_slots = max_slots + ?
        WHERE curriculum_id = ? AND active_school_year_id = ?
      `,
        [slotsToAdd, curriculum_id, activeSchoolYearId],
      );
    } else {
      await connection.query(
        `
        INSERT INTO admission.program_slots
        (curriculum_id, max_slots, active_school_year_id, created_at)
        VALUES (?, ?, ?, NOW())
      `,
        [curriculum_id, slotsToAdd, activeSchoolYearId],
      );
    }

    await connection.commit();

    const actorLabel = await getActorAuditLabel(req);
    const programLabel = await getProgramSlotLabel(curriculum_id);
    const schoolTermLabel = await getSchoolTermLabel(activeSchoolYearId);
    await insertProgramSlotAuditLog({
      req,
      action: "PROGRAM_SLOT_ADD",
      message:
        `${actorLabel} added slots to ${programLabel} for ${schoolTermLabel} ` +
        `from ${previousTotalSlots} to ${newTotalSlots} (added ${slotsToAdd}). ` +
        `[curriculum_id:${curriculum_id}] [active_school_year_id:${activeSchoolYearId}]`,
    });

    memoryCache.clear();
    res.json({
      message: "Program slots added",
      added_slots: slotsToAdd,
      max_slots: newTotalSlots,
    });
  } catch (err) {
    await connection.rollback();
    console.error("Error adding program slots:", err);
    res.status(500).json({ message: "Failed to add program slots" });
  } finally {
    connection.release();
  }
});

router.post("/program-slots/department", async (req, res) => {
  const { dprtmnt_id, max_slots, year_id, semester_id } = req.body;
  const slotValue = Number(max_slots);

  if (
    !dprtmnt_id ||
    !year_id ||
    !semester_id ||
    !Number.isInteger(slotValue) ||
    slotValue < 1
  ) {
    return res.status(400).json({ message: "Missing or invalid required fields" });
  }

  const connection = await db.getConnection();

  try {
    const [activeRows] = await db3.query(
      "SELECT id FROM active_school_year_table WHERE year_id = ? AND semester_id = ? LIMIT 1",
      [year_id, semester_id],
    );
    const activeSchoolYearId = activeRows[0]?.id;

    if (!activeSchoolYearId) {
      return res
        .status(400)
        .json({ message: "Active school year not found for selection" });
    }

    const [curriculumRows] = await db3.query(
      `
      SELECT dc.curriculum_id
      FROM dprtmnt_curriculum_table dc
      INNER JOIN curriculum_table ct ON dc.curriculum_id = ct.curriculum_id
      WHERE dc.dprtmnt_id = ?
        AND ct.lock_status = 1
    `,
      [dprtmnt_id],
    );

    const curriculumIds = curriculumRows.map((row) => row.curriculum_id);
    if (!curriculumIds.length) {
      return res
        .status(404)
        .json({ message: "No programs found for department" });
    }

    await connection.beginTransaction();

    const [existingRows] = await connection.query(
      `
      SELECT curriculum_id, max_slots
      FROM admission.program_slots
      WHERE active_school_year_id = ?
        AND curriculum_id IN (?)
    `,
      [activeSchoolYearId, curriculumIds],
    );
    const existingSet = new Set(existingRows.map((row) => row.curriculum_id));
    const previousSlotsByCurriculum = new Map(
      existingRows.map((row) => [String(row.curriculum_id), Number(row.max_slots || 0)]),
    );
    const updatedProgramCount = existingSet.size;
    const createdProgramCount = curriculumIds.length - updatedProgramCount;

    for (const curriculumId of curriculumIds) {
      if (existingSet.has(curriculumId)) {
        await connection.query(
          `
          UPDATE admission.program_slots
          SET max_slots = max_slots + ?
          WHERE curriculum_id = ? AND active_school_year_id = ?
        `,
          [slotValue, curriculumId, activeSchoolYearId],
        );
      } else {
        await connection.query(
          `
          INSERT INTO admission.program_slots
          (curriculum_id, max_slots, active_school_year_id, created_at)
          VALUES (?, ?, ?, NOW())
        `,
          [curriculumId, slotValue, activeSchoolYearId],
        );
      }
    }

    await connection.commit();
    const actorLabel = await getActorAuditLabel(req);
    const departmentLabel = await getDepartmentLabel(dprtmnt_id);
    const schoolTermLabel = await getSchoolTermLabel(activeSchoolYearId);
    await insertProgramSlotAuditLog({
      req,
      action: "PROGRAM_SLOT_DEPARTMENT_ADD",
      message: `${actorLabel} added ${slotValue} slot(s) per program to ${departmentLabel} for ${schoolTermLabel}. Programs affected: ${curriculumIds.length}. Updated existing slot records: ${updatedProgramCount}. Created new slot records: ${createdProgramCount}.`,
    });
    for (const curriculumId of curriculumIds) {
      const previousSlots = previousSlotsByCurriculum.get(String(curriculumId)) || 0;
      const currentSlots = previousSlots + slotValue;
      const programLabel = await getProgramSlotLabel(curriculumId);
      await insertProgramSlotAuditLog({
        req,
        action: "PROGRAM_SLOT_DEPARTMENT_ADD",
        message:
          `${actorLabel} added slots to ${programLabel} through the department update for ${schoolTermLabel} ` +
          `from ${previousSlots} to ${currentSlots} (added ${slotValue}). ` +
          `[curriculum_id:${curriculumId}] [active_school_year_id:${activeSchoolYearId}]`,
      });
    }
    memoryCache.clear();
    res.json({ message: "Program slots updated for department" });
  } catch (err) {
    await connection.rollback();
    console.error("Error saving department program slots:", err);
    res
      .status(500)
      .json({ message: "Failed to save department program slots" });
  } finally {
    connection.release();
  }
});

router.post("/program-slots/all", async (req, res) => {
  const { max_slots, year_id, semester_id } = req.body;
  const slotValue = Number(max_slots);

  if (
    !year_id ||
    !semester_id ||
    !Number.isInteger(slotValue) ||
    slotValue < 1
  ) {
    return res.status(400).json({ message: "Missing or invalid required fields" });
  }

  const connection = await db.getConnection();

  try {
    const [activeRows] = await db3.query(
      "SELECT id FROM active_school_year_table WHERE year_id = ? AND semester_id = ? LIMIT 1",
      [year_id, semester_id],
    );
    const activeSchoolYearId = activeRows[0]?.id;

    if (!activeSchoolYearId) {
      return res
        .status(400)
        .json({ message: "Active school year not found for selection" });
    }

    const [curriculumRows] = await db3.query(`
      SELECT dc.curriculum_id
      FROM dprtmnt_curriculum_table dc
      INNER JOIN curriculum_table ct ON dc.curriculum_id = ct.curriculum_id
      WHERE ct.lock_status = 1
    `);

    const curriculumIds = curriculumRows.map((row) => row.curriculum_id);
    if (!curriculumIds.length) {
      return res.status(404).json({ message: "No programs found" });
    }

    await connection.beginTransaction();

    const [existingRows] = await connection.query(
      `
      SELECT curriculum_id, max_slots
      FROM admission.program_slots
      WHERE active_school_year_id = ?
        AND curriculum_id IN (?)
    `,
      [activeSchoolYearId, curriculumIds],
    );
    const existingSet = new Set(existingRows.map((row) => row.curriculum_id));
    const previousSlotsByCurriculum = new Map(
      existingRows.map((row) => [String(row.curriculum_id), Number(row.max_slots || 0)]),
    );
    const updatedProgramCount = existingSet.size;
    const createdProgramCount = curriculumIds.length - updatedProgramCount;

    for (const curriculumId of curriculumIds) {
      if (existingSet.has(curriculumId)) {
        await connection.query(
          `
          UPDATE admission.program_slots
          SET max_slots = max_slots + ?
          WHERE curriculum_id = ? AND active_school_year_id = ?
        `,
          [slotValue, curriculumId, activeSchoolYearId],
        );
      } else {
        await connection.query(
          `
          INSERT INTO admission.program_slots
          (curriculum_id, max_slots, active_school_year_id, created_at)
          VALUES (?, ?, ?, NOW())
        `,
          [curriculumId, slotValue, activeSchoolYearId],
        );
      }
    }

    await connection.commit();
    const actorLabel = await getActorAuditLabel(req);
    const schoolTermLabel = await getSchoolTermLabel(activeSchoolYearId);
    await insertProgramSlotAuditLog({
      req,
      action: "PROGRAM_SLOT_ALL_ADD",
      message: `${actorLabel} added ${slotValue} slot(s) per program to all active programs for ${schoolTermLabel}. Programs affected: ${curriculumIds.length}. Updated existing slot records: ${updatedProgramCount}. Created new slot records: ${createdProgramCount}.`,
    });
    for (const curriculumId of curriculumIds) {
      const previousSlots = previousSlotsByCurriculum.get(String(curriculumId)) || 0;
      const currentSlots = previousSlots + slotValue;
      const programLabel = await getProgramSlotLabel(curriculumId);
      await insertProgramSlotAuditLog({
        req,
        action: "PROGRAM_SLOT_ALL_ADD",
        message:
          `${actorLabel} added slots to ${programLabel} through the all-program update for ${schoolTermLabel} ` +
          `from ${previousSlots} to ${currentSlots} (added ${slotValue}). ` +
          `[curriculum_id:${curriculumId}] [active_school_year_id:${activeSchoolYearId}]`,
      });
    }
    memoryCache.clear();
    res.json({ message: "Program slots updated for all programs" });
  } catch (err) {
    await connection.rollback();
    console.error("Error saving program slots for all programs:", err);
    res.status(500).json({ message: "Failed to save program slots" });
  } finally {
    connection.release();
  }
});

router.put("/program-slots/e-status", async (req, res) => {
  const { curriculum_id, year_id, semester_id, e_status } = req.body;
  const statusValue = Number(e_status) === 1 ? 1 : 0;

  if (!curriculum_id || !year_id || !semester_id) {
    return res
      .status(400)
      .json({ message: "curriculum_id, year_id, and semester_id are required" });
  }

  try {
    await ensureProgramSlotsEStatusColumn();

    const [activeRows] = await db3.query(
      "SELECT id FROM active_school_year_table WHERE year_id = ? AND semester_id = ? LIMIT 1",
      [year_id, semester_id],
    );
    const activeSchoolYearId = activeRows[0]?.id;

    if (!activeSchoolYearId) {
      return res
        .status(400)
        .json({ message: "Active school year not found for selection" });
    }

    const [[existing]] = await db.query(
      `SELECT slot_id, e_status
       FROM admission.program_slots
       WHERE curriculum_id = ? AND active_school_year_id = ?
       LIMIT 1`,
      [curriculum_id, activeSchoolYearId],
    );

    if (existing) {
      await db.query(
        `UPDATE admission.program_slots
         SET e_status = ?
         WHERE curriculum_id = ? AND active_school_year_id = ?`,
        [statusValue, curriculum_id, activeSchoolYearId],
      );
    } else {
      await db.query(
        `INSERT INTO admission.program_slots
         (curriculum_id, max_slots, active_school_year_id, e_status, created_at)
         VALUES (?, 0, ?, ?, NOW())`,
        [curriculum_id, activeSchoolYearId, statusValue],
      );
    }

    const actorLabel = await getActorAuditLabel(req);
    const programLabel = await getProgramSlotLabel(curriculum_id);
    const schoolTermLabel = await getSchoolTermLabel(activeSchoolYearId);
    await insertProgramSlotAuditLog({
      req,
      action: "PROGRAM_SLOT_E_STATUS",
      message: `${actorLabel} set e_status=${statusValue} for ${programLabel} for ${schoolTermLabel}.`,
    });

    memoryCache.clear();
    res.json({
      message: "Program e_status updated",
      curriculum_id,
      e_status: statusValue,
    });
  } catch (err) {
    console.error("Error updating program e_status:", err);
    res.status(500).json({ message: "Failed to update program e_status" });
  }
});

router.delete("/program-slots/reset", async (req, res) => {
  const { curriculum_id, year_id, semester_id } = req.body;
 
  if (!curriculum_id || !year_id || !semester_id) {
    return res.status(400).json({ error: "curriculum_id, year_id, and semester_id are required" });
  }
 
  try {
    const [result] = await db.query(
      `DELETE FROM program_slots
       WHERE curriculum_id = ?
         AND active_school_year_id = (
           SELECT id FROM enrollment.active_school_year_table
           WHERE year_id = ? AND semester_id = ?
           LIMIT 1
         )`,
      [curriculum_id, year_id, semester_id]
    );
 
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "No slot record found for this program in the selected period" });
    }
 
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) {
    console.error("Failed to reset single program slot:", err);
    res.status(500).json({ error: "Failed to reset slot" });
  }
});

router.delete("/program-slots/reset/department", async (req, res) => {
  const { dprtmnt_id, year_id, semester_id } = req.body;
 
  if (!dprtmnt_id || !year_id || !semester_id) {
    return res.status(400).json({ error: "dprtmnt_id, year_id, and semester_id are required" });
  }
 
  try {
    const [result] = await db.query(
      `DELETE ps FROM admission.program_slots ps
       INNER JOIN enrollment.curriculum_table ct ON ps.curriculum_id = ct.curriculum_id
       INNER JOIN enrollment.dprtmnt_curriculum_table dc ON ct.curriculum_id = dc.curriculum_id
       WHERE dc.dprtmnt_id = ?
         AND ps.active_school_year_id = (
           SELECT id FROM enrollment.active_school_year_table
           WHERE year_id = ? AND semester_id = ?
           LIMIT 1
         )`,
      [dprtmnt_id, year_id, semester_id]
    );
 
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) {
    console.error("Failed to reset department slots:", err);
    res.status(500).json({ error: "Failed to reset department slots" });
  }
});

router.delete("/program-slots/reset/all", async (req, res) => {
  const { year_id, semester_id } = req.body;
 
  if (!year_id || !semester_id) {
    return res.status(400).json({ error: "year_id and semester_id are required" });
  }
 
  try {
    const [result] = await db.query(
      `DELETE FROM admission.program_slots
       WHERE active_school_year_id = (
         SELECT id FROM enrollment.active_school_year_table
         WHERE year_id = ? AND semester_id = ?
         LIMIT 1
       )`,
      [year_id, semester_id]
    );
 
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) {
    console.error("Failed to reset all slots:", err);
    res.status(500).json({ error: "Failed to reset all slots" });
  }
});

router.get("/applied_program", async (req, res) => {
  try {
    await ensureProgramSlotsEStatusColumn();

    const [rows] = await db3.execute(`
      SELECT
        ct.curriculum_id,
        ct.year_id,
        yt.year_description,
        yt.year_description AS current_year,
        yt.year_description + 1 AS next_year,
        pt.program_id,
        pt.program_code,
        pt.program_description,
        pt.major,
        pt.components,
        pt.academic_program,
        d.dprtmnt_id,
        d.dprtmnt_name,
        d.dept_number,
        d.components,
        COALESCE(ps.e_status, 0) AS e_status
      FROM curriculum_table AS ct
      INNER JOIN program_table AS pt ON pt.program_id = ct.program_id
      INNER JOIN dprtmnt_curriculum_table AS dc ON ct.curriculum_id = dc.curriculum_id
      INNER JOIN year_table AS yt ON ct.year_id = yt.year_id
      INNER JOIN dprtmnt_table AS d ON dc.dprtmnt_id = d.dprtmnt_id
      LEFT JOIN active_school_year_table AS asy ON asy.astatus = 1
      LEFT JOIN admission.program_slots AS ps
        ON ps.curriculum_id = ct.curriculum_id
       AND ps.active_school_year_id = asy.id
      WHERE ct.lock_status = 1
    `);

    if (rows.length === 0) {
      return res.status(404).json({ error: "No curriculum data found" });
    }

    res.json(rows);
  } catch (error) {
    console.error("Error fetching curriculum data:", error);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
