const express = require("express");
const { db, db3 } = require("../database/database");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();

const formatActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const formatVerifyScheduleLabel = (schedule) => {
  if (!schedule) return "Unknown schedule";

  return `Schedule ${schedule.schedule_id || "New"} (${schedule.schedule_date}, ${schedule.building_description || "N/A"} ${schedule.room_description || ""}, ${schedule.start_time || ""}-${schedule.end_time || ""})`;
};

const getVerifyScheduleLabel = async (scheduleId) => {
  if (!scheduleId) return "No schedule";

  const [rows] = await db.query(
    `
    SELECT schedule_id, schedule_date, building_description, room_description, start_time, end_time
    FROM verify_document_schedule
    WHERE schedule_id = ?
    LIMIT 1
    `,
    [scheduleId],
  );

  const schedule = rows?.[0];
  if (!schedule) return `Schedule ${scheduleId}`;

  return `Schedule ${schedule.schedule_id} (${schedule.schedule_date}, ${schedule.building_description || "N/A"} ${schedule.room_description || ""}, ${schedule.start_time || ""}-${schedule.end_time || ""})`;
};

const insertVerifyScheduleAuditLog = async ({
  actorId,
  actorRole,
  action = "VERIFY_SCHEDULE",
  message,
}) => {
  await insertAuditLogAdmission({
    actorId: actorId || "unknown",
    role: actorRole || "registrar",
    action,
    severity: "INFO",
    message,
  });
};

// ASSIGN VERIFY DOCUMENTS SCHEDULE //
router.post("/create_verify_document_schedule", async (req, res) => {
  try {
    const {
      schedule_date,
      branch, // ✅ added
      building_description,
      room_description,
      start_time,
      end_time,
      evaluator,
      room_quota,
      active_school_year_id,
    } = req.body;

    // ✅ Validate required fields
    if (
      !schedule_date ||
      !branch ||
      !building_description ||
      !room_description ||
      !start_time ||
      !end_time ||
      !room_quota ||
      !active_school_year_id
    ) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // 🔍 CHECK DUPLICATE (NOW INCLUDING BRANCH)
    const [existing] = await db.query(
      `
      SELECT 1
      FROM verify_document_schedule
      WHERE schedule_date = ?
        AND branch = ?
        AND building_description = ?
        AND room_description = ?
      `,
      [schedule_date, branch, building_description, room_description]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error: "⚠️ Room already exists for this branch on this date."
      });
    }

    // ✅ INSERT
    const sql = `
      INSERT INTO verify_document_schedule
      (schedule_date, branch, building_description, room_description,
       start_time, end_time, evaluator, room_quota, active_school_year_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;

    const [result] = await db.query(sql, [
      schedule_date,
      branch,
      building_description,
      room_description,
      start_time,
      end_time,
      evaluator,
      room_quota,
      active_school_year_id
    ]);

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatActorRole(actorRole);
    await insertVerifyScheduleAuditLog({
      actorId,
      actorRole,
      action: "VERIFY_DOCUMENT_SCHEDULE_CREATE",
      message: `${roleLabel} (${actorId}) created document verification ${formatVerifyScheduleLabel({
        schedule_id: result.insertId,
        schedule_date,
        building_description,
        room_description,
        start_time,
        end_time,
      })}. Evaluator: ${evaluator || "N/A"}. Room quota: ${room_quota}.`,
    });

    res.json({
      message: "Verify document schedule created successfully ✅",
      schedule_id: result.insertId
    });

  } catch (err) {
    console.error("❌ Error creating verify document schedule:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET verify document schedules
// GET verify document schedules
router.get("/verify_document_schedule_list", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        schedule_id,
        schedule_date,
        branch,   -- ✅ added
        building_description,
        room_description,
        start_time,
        end_time,
        evaluator,
        room_quota
      FROM verify_document_schedule
      ORDER BY schedule_date, start_time
    `);

    res.json(rows);

  } catch (err) {
    console.error("❌ Error fetching verify document schedules:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// UPDATE verify document schedule
// UPDATE verify document schedule
router.put("/update_verify_document_schedule/:schedule_id", async (req, res) => {
  try {
    const { schedule_id } = req.params;

    const {
      schedule_date,
      branch, // ✅ added
      building_description,
      room_description,
      start_time,
      end_time,
      evaluator,
      room_quota
    } = req.body;

    if (
      !schedule_date ||
      !branch ||
      !building_description ||
      !room_description ||
      !start_time ||
      !end_time ||
      !room_quota
    ) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const [[scheduleBefore]] = await db.query(
      "SELECT * FROM verify_document_schedule WHERE schedule_id = ? LIMIT 1",
      [schedule_id],
    );

    if (!scheduleBefore) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    const sql = `
      UPDATE verify_document_schedule
      SET schedule_date = ?, 
          branch = ?,   -- ✅ added
          building_description = ?, 
          room_description = ?, 
          start_time = ?, 
          end_time = ?, 
          evaluator = ?, 
          room_quota = ?
      WHERE schedule_id = ?
    `;

    await db.query(sql, [
      schedule_date,
      branch,
      building_description,
      room_description,
      start_time,
      end_time,
      evaluator,
      room_quota,
      schedule_id
    ]);

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatActorRole(actorRole);
    await insertVerifyScheduleAuditLog({
      actorId,
      actorRole,
      action: "VERIFY_DOCUMENT_SCHEDULE_UPDATE",
      message: `${roleLabel} (${actorId}) updated document verification ${formatVerifyScheduleLabel(scheduleBefore)} to ${formatVerifyScheduleLabel({
        schedule_id,
        schedule_date,
        building_description,
        room_description,
        start_time,
        end_time,
      })}. Evaluator: ${evaluator || "N/A"}. Room quota: ${room_quota}.`,
    });

    res.json({ message: "Schedule updated successfully ✅" });

  } catch (err) {
    console.error("❌ Error updating verify document schedule:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// DELETE verify document schedule
router.delete("/delete_verify_document_schedule/:schedule_id", async (req, res) => {
  try {
    const { schedule_id } = req.params;

    const [[scheduleBefore]] = await db.query(
      "SELECT * FROM verify_document_schedule WHERE schedule_id = ? LIMIT 1",
      [schedule_id],
    );

    const [result] = await db.query(
      `DELETE FROM verify_document_schedule WHERE schedule_id = ?`,
      [schedule_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatActorRole(actorRole);
    await insertVerifyScheduleAuditLog({
      actorId,
      actorRole,
      action: "VERIFY_DOCUMENT_SCHEDULE_DELETE",
      message: `${roleLabel} (${actorId}) deleted document verification ${formatVerifyScheduleLabel(scheduleBefore)}.`,
    });

    res.json({ message: "Schedule deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/verified-for-verify-schedule", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT DISTINCT
        p.person_id,
        p.applyingAs,
        p.last_name,
        p.first_name,
        p.middle_name,
        p.extension,
        p.emailAddress,
        p.campus,
        p.program,
        p.created_at,
        a.applicant_number,
        SUBSTRING(a.applicant_number, 5, 1) AS middle_code,
        ea.schedule_id,
        ea.email_sent,
        ees.room_description,
        ees.start_time,
        ees.end_time
      FROM admission.person_table AS p
      LEFT JOIN admission.applicant_numbering_table AS a 
        ON p.person_id = a.person_id
      LEFT JOIN admission.verify_applicants AS ea 
        ON a.applicant_number = ea.applicant_id
      LEFT JOIN admission.verify_document_schedule AS ees
        ON ea.schedule_id = ees.schedule_id
      LEFT JOIN admission.person_status_table AS ps 
        ON p.person_id = ps.person_id
      WHERE p.person_id IN (
        SELECT ru.person_id
        FROM admission.requirement_uploads ru
        INNER JOIN admission.person_table pt2 ON ru.person_id = pt2.person_id
        INNER JOIN admission.requirements_table rt2 ON ru.requirements_id = rt2.id
        WHERE ru.document_status = 'Documents Verified & ECAT'
        GROUP BY ru.person_id
        HAVING COUNT(DISTINCT ru.requirements_id) >= (
            SELECT COUNT(*)
            FROM requirements_table rt2
            INNER JOIN person_table p2
              ON rt2.applicant_type = p2.applyingAs
            WHERE rt2.category = 'Main'
              AND rt2.is_verifiable = 1
              AND p2.person_id = ru.person_id
          )
      )
      AND (ea.email_sent IS NULL OR ea.email_sent = 0)   -- ⬅️ only show those not yet emailed
      ORDER BY p.last_name ASC, p.first_name ASC;
    `);

    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching verified ECAT applicants:", err);
    res.status(500).send("Server error");
  }
});

router.post("/unassign_verify", async (req, res) => {
  const { applicant_number, audit_actor_id, audit_actor_role } = req.body;

  try {
    const [[currentAssignment]] = await db.query(
      `SELECT schedule_id, COALESCE(email_sent, 0) AS email_sent
       FROM verify_applicants
       WHERE applicant_id = ?
       LIMIT 1`,
      [applicant_number],
    );
    if (Number(currentAssignment?.email_sent || 0) === 1) {
      return res.status(409).json({
        error: "Applicant email was already sent. Cannot unassign.",
      });
    }

    await db.query(
      `UPDATE verify_applicants
       SET schedule_id = NULL
       WHERE applicant_id = ?
       AND COALESCE(email_sent, 0) <> 1`,
      [applicant_number]
    );

    if (currentAssignment?.schedule_id) {
      const safeActor = audit_actor_id || "unknown";
      const roleLabel = formatActorRole(audit_actor_role);
      const scheduleLabel = await getVerifyScheduleLabel(currentAssignment.schedule_id);

      await insertVerifyScheduleAuditLog({
        actorId: safeActor,
        actorRole: audit_actor_role,
        message: `${roleLabel} (${safeActor}) unassigned Applicant (${applicant_number}) from document verification ${scheduleLabel}.`,
      });
    }

    res.json({
      success: true,
      message: `Applicant ${applicant_number} unassigned from verification.`,
    });
  } catch (err) {
    console.error("❌ Unassign verify error:", err);
    res.status(500).json({ error: "Failed to unassign applicant." });
  }
});

router.post("/unassign_all_from_verify", async (req, res) => {
  const { schedule_id, audit_actor_id, audit_actor_role } = req.body;

  try {
    const [assignedRows] = await db.query(
      `SELECT applicant_id
       FROM verify_applicants
       WHERE schedule_id = ?
       AND COALESCE(email_sent, 0) <> 1`,
      [schedule_id],
    );

    await db.query(
      `UPDATE verify_applicants
       SET schedule_id = NULL
       WHERE schedule_id = ?
       AND COALESCE(email_sent, 0) <> 1`,
      [schedule_id]
    );

    if (assignedRows.length > 0) {
      const safeActor = audit_actor_id || "unknown";
      const roleLabel = formatActorRole(audit_actor_role);
      const scheduleLabel = await getVerifyScheduleLabel(schedule_id);

      await insertVerifyScheduleAuditLog({
        actorId: safeActor,
        actorRole: audit_actor_role,
        message: `${roleLabel} (${safeActor}) unassigned ${assignedRows.length} applicant(s) from document verification ${scheduleLabel}.`,
      });
    }

    res.json({
      success: true,
      message: `${assignedRows.length} unsent applicant(s) unassigned from verify schedule ${schedule_id}. Sent applicants stayed assigned.`,
    });
  } catch (err) {
    console.error("❌ Unassign all verify error:", err);
    res.status(500).json({ error: "Failed to unassign all applicants." });
  }
});

router.get("/verify_document_schedules_with_count", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        s.schedule_id,
        s.branch,
        s.schedule_date,
        s.building_description,
        s.room_description,
        s.start_time,
        s.end_time,
        s.evaluator,
        s.room_quota,
        s.created_at,
        COUNT(va.applicant_id) AS current_occupancy,
        (s.room_quota - COUNT(va.applicant_id)) AS remaining_slots
      FROM verify_document_schedule s
      LEFT JOIN verify_applicants va
        ON s.schedule_id = va.schedule_id
      GROUP BY s.schedule_id
      ORDER BY s.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching verify schedules with count:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /api/verify-document-schedule/:applicantNumber
router.get("/verify-document-schedule/:applicantNumber", async (req, res) => {
  const { applicantNumber } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT
         va.id,
         va.schedule_id,
         va.applicant_id,
         va.email_sent,
         vds.schedule_date        AS day_description,
         vds.building_description,
         vds.room_description,
         vds.start_time,
         vds.end_time,
         vds.evaluator,
         vds.branch
       FROM verify_applicants va
       JOIN verify_document_schedule vds
         ON vds.schedule_id = va.schedule_id
       WHERE va.applicant_id = ?
       LIMIT 1`,
      [applicantNumber]
    );

    if (!rows.length) return res.json(null);

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching verify document schedule:", err);
    res.status(500).json({ error: "Failed to fetch verify document schedule" });
  }
});

router.post("/mark-verify-email-sent", async (req, res) => {
  const { applicant_number } = req.body;

  try {
    await db.query(
      `UPDATE verify_applicants 
       SET email_sent = 1 
       WHERE applicant_id = ?`,
      [applicant_number]
    );

    res.json({
      success: true,
      message: "Email marked as sent",
    });

  } catch (err) {
    console.error("❌ Mark email sent error:", err);
    res.status(500).json({ error: "Failed to update email status" });
  }
});

router.get("/verify-document-applicants", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        id,
        schedule_id,
        applicant_id AS applicant_number,
        email_sent
      FROM verify_applicants
      WHERE email_sent = 0
      ORDER BY id DESC
    `);

    res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/verify_schedules_with_count", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        s.schedule_id,
        s.branch,
        s.schedule_date,
        s.building_description,
        s.room_description,
        s.start_time,
        s.end_time,
        s.evaluator,
        s.room_quota,
        IFNULL(COUNT(a.applicant_id), 0) AS current_occupancy,
        (s.room_quota - IFNULL(COUNT(a.applicant_id), 0)) AS remaining_slots
      FROM verify_document_schedule s
      LEFT JOIN verify_applicants a
        ON s.schedule_id = a.schedule_id
      GROUP BY 
        s.schedule_id,
        s.schedule_date,
        s.building_description,
        s.room_description,
        s.start_time,
        s.end_time,
        s.evaluator,
        s.branch,
        s.room_quota
      ORDER BY s.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching verify schedules:", err);
    res.status(500).json({ error: "Failed to fetch verify schedules" });
  }
});

router.get("/evaluator-applicants", async (req, res) => {
  const { query, schedule_id, branch } = req.query;

  const scheduleFilters = ["evaluator LIKE ?"];
  const scheduleParams = [`%${query || ""}%`];

  if (schedule_id) {
    scheduleFilters.push("schedule_id = ?");
    scheduleParams.push(schedule_id);
  }

  if (branch) {
    scheduleFilters.push("branch = ?");
    scheduleParams.push(branch);
  }

  try {
    const [schedules] = await db.query(
      `
      SELECT *
      FROM verify_document_schedule
      WHERE ${scheduleFilters.join(" AND ")}
      `,
      scheduleParams
    );

    if (schedules.length === 0) return res.json([]);

    const results = await Promise.all(
      schedules.map(async (schedule) => {
        const [applicants] = await db.query(
          `
          SELECT 
            va.applicant_id AS applicant_number,
            va.email_sent,
            pt.last_name,
            pt.first_name,
            pt.middle_name,
            pt.program,
            s.building_description,
            s.room_description
          FROM verify_applicants va
          JOIN applicant_numbering_table an 
            ON an.applicant_number = va.applicant_id
          JOIN person_table pt 
            ON pt.person_id = an.person_id
          JOIN verify_document_schedule s
            ON s.schedule_id = va.schedule_id
        WHERE va.schedule_id = ?
AND (va.email_sent IS NULL OR va.email_sent = 1)

          `,
          [schedule.schedule_id]
        );

        return { schedule, applicants };
      })
    );

    res.json(results);
  } catch (err) {
    console.error("❌ Error fetching evaluator applicants:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/unassign_verify_evaluator_applicant_list", async (req, res) => {
  const { applicant_number, audit_actor_id, audit_actor_role } = req.body;

  if (!applicant_number) {
    return res.status(400).json({ message: "Missing applicant_number" });
  }

  try {
    const [[currentAssignment]] = await db.query(
      `
      SELECT
        va.schedule_id,
        pt.last_name,
        pt.first_name,
        pt.middle_name
      FROM verify_applicants va
      LEFT JOIN applicant_numbering_table an
        ON an.applicant_number = va.applicant_id
      LEFT JOIN person_table pt
        ON pt.person_id = an.person_id
      WHERE va.applicant_id = ?
      LIMIT 1
      `,
      [applicant_number],
    );

    await db.query(
      `
      UPDATE verify_applicants
      SET schedule_id = NULL,
          email_sent = 0
      WHERE applicant_id = ?
      `,
      [applicant_number]
    );

    if (currentAssignment?.schedule_id) {
      const safeActor = audit_actor_id || "unknown";
      const roleLabel = formatActorRole(audit_actor_role);
      const scheduleLabel = await getVerifyScheduleLabel(currentAssignment.schedule_id);
      const applicantName = [
        currentAssignment.last_name,
        currentAssignment.first_name,
        currentAssignment.middle_name,
      ]
        .filter(Boolean)
        .join(", ");
      const applicantLabel = applicantName
        ? `${applicant_number} - ${applicantName}`
        : applicant_number;

      await insertVerifyScheduleAuditLog({
        actorId: safeActor,
        actorRole: audit_actor_role,
        message: `${roleLabel} (${safeActor}) removed Applicant (${applicantLabel}) from evaluator applicant list for document verification ${scheduleLabel}.`,
      });
    }

    res.json({
      success: true,
      message: `Applicant ${applicant_number} removed from verify schedule.`,
    });
  } catch (err) {
    console.error("❌ Unassign verify error:", err);
    res.status(500).json({ error: "Failed to unassign applicant." });
  }
});

router.get("/verify_schedules", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        s.schedule_id,
        s.branch,
        s.schedule_date,
        s.building_description,
        s.room_description,
        s.start_time,
        s.end_time,
        s.evaluator,
        s.room_quota,
        COUNT(va.applicant_id) AS assigned_count
      FROM verify_document_schedule s
      LEFT JOIN verify_applicants va
        ON s.schedule_id = va.schedule_id
      GROUP BY s.schedule_id
      ORDER BY s.schedule_id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching verify schedules:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/verify_schedules_with_count/:yearId/:semesterId", async (req, res) => {
  const { yearId, semesterId } = req.params;
  const { branch } = req.query;

  const queryParams = [yearId, semesterId];
  let branchClause = "";

  if (branch) {
    branchClause = " AND s.branch = ?";
    queryParams.push(branch);
  }

  try {
    const [rows] = await db.query(
      `
      SELECT 
        s.schedule_id,
        s.schedule_date,
        s.building_description,
        s.room_description,
        s.start_time,
        s.end_time,
        s.evaluator,
        s.branch,
        s.room_quota,
        s.created_at,
        sy.year_id,
        sy.semester_id,
        IFNULL(COUNT(a.applicant_id), 0) AS current_occupancy,
        (s.room_quota - IFNULL(COUNT(a.applicant_id), 0)) AS remaining_slots
      FROM verify_document_schedule s
      JOIN enrollment.active_school_year_table sy ON s.active_school_year_id = sy.id
      LEFT JOIN verify_applicants a
        ON s.schedule_id = a.schedule_id
      WHERE sy.year_id = ? AND sy.semester_id = ?${branchClause}
      GROUP BY
        s.schedule_id,
        s.schedule_date,
        s.building_description,
        s.room_description,
        s.start_time,
        s.end_time,
        s.evaluator,
        s.branch,
        s.room_quota,
        s.created_at,
        sy.year_id,
        sy.semester_id
      ORDER BY s.schedule_date, s.start_time
    `,
      queryParams
    );

    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching verify schedules:", err);
    res.status(500).json({ error: "Failed to fetch verify schedules" });
  }
});

const toManilaIsoLike = (utcDate) => {
  if (!utcDate) return null;
  const d = new Date(utcDate);
  if (isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const y = get("year");
  const mo = get("month");
  const da = get("day");
  let h = get("hour");
  const mi = get("minute");
  const se = get("second");
  if (h === "24") h = "00"; // Intl can render midnight as "24" — normalize it

  return `${y}-${mo}-${da}T${h}:${mi}:${se}.000Z`;
};

router.get("/document-verification/:applicant_number", async (req, res) => {
  const { applicant_number } = req.params;

  try {
    // 1) Resolve person_id + applicant_type (applyingAs) for this applicant
    const [[person]] = await db.query(
      `
      SELECT pt.person_id, pt.applyingAs
      FROM applicant_numbering_table ant
      INNER JOIN person_table pt ON ant.person_id = pt.person_id
      WHERE ant.applicant_number = ?
      LIMIT 1
      `,
      [applicant_number],
    );

    if (!person) {
      return res.status(404).json({ message: "Applicant not found" });
    }

    const { person_id, applyingAs } = person;

    // 2) Figure out which requirements are required + verifiable for this applicant type
    const [requiredRows] = await db.query(
      `
      SELECT id
      FROM requirements_table
      WHERE category = 'Main'
        AND is_verifiable = 1
        AND (
          applicant_type = ?
          OR applicant_type = '0'
          OR applicant_type = 0
          OR applicant_type = 'All'
        )
      `,
      [applyingAs],
    );

    if (requiredRows.length === 0) {
      return res.json({
        verified: false,
        verified_at: null,
        verified_by: null,
        message: "No verifiable requirements configured for this applicant type.",
      });
    }

    const requiredIds = requiredRows.map((r) => r.id);
    const placeholders = requiredIds.map(() => "?").join(",");

    // 3) Pull this applicant's uploads for exactly those requirement ids
    const [uploadRows] = await db.query(
      `
      SELECT requirements_id, document_status, verified_at, created_at, last_updated_by
      FROM requirement_uploads
      WHERE person_id = ?
        AND requirements_id IN (${placeholders})
      `,
      [person_id, ...requiredIds],
    );

    // Must have an upload row for every required requirement, and every one
    // of those must be verified, for the applicant to count as fully verified.
    const uploadedIds = new Set(uploadRows.map((u) => u.requirements_id));
    const hasAllRequired = requiredIds.every((id) => uploadedIds.has(id));
    const allVerified =
      hasAllRequired &&
      uploadRows.every((u) => u.document_status === "Documents Verified & ECAT");

    if (!allVerified) {
      return res.json({
        verified: false,
        verified_at: null,
        verified_by: null,
        required_count: requiredIds.length,
        verified_count: uploadRows.filter(
          (u) => u.document_status === "Documents Verified & ECAT",
        ).length,
      });
    }

    // 4) All required docs verified — "Date Verified" is when the LAST one
    //    was verified, i.e. the max(verified_at) among the verified rows.
    const latestRow = uploadRows.reduce((latest, row) => {
      const rowVerifiedAt = row.verified_at || row.created_at;
      if (!latest) return row;
      const latestVerifiedAt = latest.verified_at || latest.created_at;
      return new Date(rowVerifiedAt) > new Date(latestVerifiedAt) ? row : latest;
    }, null);

    let verifiedBy = null;
    if (latestRow?.last_updated_by) {
      // last_updated_by stores a person_id that lives in the ENROLLMENT db (db3),
      // same cross-db join pattern used elsewhere in this file
      // (e.g. LEFT JOIN enrollment.user_accounts ua ON ru.last_updated_by = ua.person_id)
      const [[actor]] = await db3.query(
        `
        SELECT role, employee_id, first_name, middle_name, last_name, email
        FROM user_accounts
        WHERE person_id = ?
        LIMIT 1
        `,
        [latestRow.last_updated_by],
      );

      if (actor) {
        const roleLabel = String(actor.role || "registrar")
          .split(/[\s_-]+/)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
          .join(" ");
        const fullName = [actor.last_name, actor.first_name, actor.middle_name]
          .filter(Boolean)
          .join(", ");

        verifiedBy = {
          employee_id: actor.employee_id || null,
          role: actor.role || null,
          name: fullName || actor.email || "Unknown",
          display: `${roleLabel}${actor.employee_id ? ` (${actor.employee_id})` : ""} - ${fullName || actor.email}`,
        };
      }
    }

    res.json({
      verified: true,
      verified_at: toManilaIsoLike(latestRow.verified_at || latestRow.created_at),
      verified_by: verifiedBy,
      required_count: requiredIds.length,
      verified_count: uploadRows.length,
    });
  } catch (err) {
    console.error("Error fetching document verification info:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
