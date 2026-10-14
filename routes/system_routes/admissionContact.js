const express = require("express");
const { db } = require("../database/database");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");

const router = express.Router();

const getAuditActor = resolveAuditActor;

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const contactLabel = (row) =>
  row?.email ? `"${row.email}"` : `Admission Contact ${row?.id || "unknown"}`;

const insertContactAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

// ✅ Basic validators
const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

const isValidTime = (time) =>
  /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(String(time || "").trim());

const DAY_OPTIONS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const getValidBranchIds = async () => {
  const [[row]] = await db.query("SELECT branches FROM company_settings LIMIT 1");
  try {
    const branches = JSON.parse(row?.branches || "[]");
    return branches.map((b) => Number(b.id));
  } catch {
    return [];
  }
};

// GET all admission contact records
router.get("/admission_contact", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         id, branch_id, email, contact_number,
         office_days_start, office_days_end,
         office_time_start, office_time_end,
         facebook_url, created_at, updated_at
       FROM admission_contact_settings
       ORDER BY branch_id ASC, id ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching admission contact settings:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET single record (handy for applicant-facing dashboard — first/active row)
router.get("/admission_contact/active", async (req, res) => {
  const branchId = Number(req.query.branch_id) || 1;
  try {
    const [[row]] = await db.query(
      `SELECT
         id, branch_id, email, contact_number,
         office_days_start, office_days_end,
         office_time_start, office_time_end, facebook_url
       FROM admission_contact_settings
       WHERE branch_id = ?
       ORDER BY id ASC
       LIMIT 1`,
      [branchId]
    );
    res.json(row || null);
  } catch (err) {
    console.error("Error fetching active admission contact:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// CREATE
router.post("/admission_contact", CanCreate, async (req, res) => {
  const {
    branch_id,
    email,
    contact_number,
    office_days_start,
    office_days_end,
    office_time_start,
    office_time_end,
    facebook_url,
  } = req.body;

  // ✅ CHANGED: email and contact_number are now optional — only
  // branch_id and the office days/hours remain required, since those
  // drive the dashboard's schedule display.
  if (!branch_id || !office_days_start || !office_days_end || !office_time_start || !office_time_end) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const validBranchIds = await getValidBranchIds();
  if (!validBranchIds.includes(Number(branch_id))) {
    return res.status(400).json({ error: "Invalid branch" });
  }

  // ✅ CHANGED: only validate email format if one was actually provided.
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!DAY_OPTIONS.includes(office_days_start) || !DAY_OPTIONS.includes(office_days_end)) {
    return res.status(400).json({ error: "Invalid office day value" });
  }

  if (!isValidTime(office_time_start) || !isValidTime(office_time_end)) {
    return res.status(400).json({ error: "Invalid office time value" });
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO admission_contact_settings
         (branch_id, email, contact_number, office_days_start, office_days_end, office_time_start, office_time_end, facebook_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        branch_id,
        email?.trim() || null,
        contact_number?.trim() || null,
        office_days_start,
        office_days_end,
        office_time_start,
        office_time_end,
        facebook_url?.trim() || null,
      ]
    );

    const insertedId = result.insertId;
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertContactAuditLog({
      req,
      action: "ADMISSION_CONTACT_CREATE",
      message: `${roleLabel} (${actorId}) created admission contact ${contactLabel({ id: insertedId, email })} for branch ${branch_id}.`,
    });

    res.json({ message: "Admission contact created", id: insertedId });
  } catch (err) {
    console.error("Error inserting admission contact:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// UPDATE
router.put("/admission_contact/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const {
    branch_id,
    email,
    contact_number,
    office_days_start,
    office_days_end,
    office_time_start,
    office_time_end,
    facebook_url,
  } = req.body;

  // ✅ CHANGED: email and contact_number are now optional — same relaxed
  // requirement as the CREATE route above.
  if (!branch_id || !office_days_start || !office_days_end || !office_time_start || !office_time_end) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const validBranchIds = await getValidBranchIds();
  if (!validBranchIds.includes(Number(branch_id))) {
    return res.status(400).json({ error: "Invalid branch" });
  }

  // ✅ CHANGED: only validate email format if one was actually provided.
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!DAY_OPTIONS.includes(office_days_start) || !DAY_OPTIONS.includes(office_days_end)) {
    return res.status(400).json({ error: "Invalid office day value" });
  }

  if (!isValidTime(office_time_start) || !isValidTime(office_time_end)) {
    return res.status(400).json({ error: "Invalid office time value" });
  }

  try {
    const [[before]] = await db.execute(
      "SELECT id, email FROM admission_contact_settings WHERE id = ? LIMIT 1",
      [id]
    );

    const [result] = await db.execute(
      `UPDATE admission_contact_settings
       SET branch_id = ?, email = ?, contact_number = ?, office_days_start = ?, office_days_end = ?,
           office_time_start = ?, office_time_end = ?, facebook_url = ?
       WHERE id = ?`,
      [
        branch_id,
        email?.trim() || null,
        contact_number?.trim() || null,
        office_days_start,
        office_days_end,
        office_time_start,
        office_time_end,
        facebook_url?.trim() || null,
        id,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Admission contact not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertContactAuditLog({
      req,
      action: "ADMISSION_CONTACT_UPDATE",
      message: `${roleLabel} (${actorId}) updated admission contact ${contactLabel(before)} for branch ${branch_id}.`,
    });

    res.json({ message: "Admission contact updated successfully" });
  } catch (err) {
    console.error("Error updating admission contact:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE
router.delete("/admission_contact/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[before]] = await db.execute(
      "SELECT id, email FROM admission_contact_settings WHERE id = ? LIMIT 1",
      [id]
    );

    const [result] = await db.execute(
      "DELETE FROM admission_contact_settings WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Admission contact not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertContactAuditLog({
      req,
      action: "ADMISSION_CONTACT_DELETE",
      message: `${roleLabel} (${actorId}) deleted admission contact ${contactLabel(before)}.`,
    });

    res.json({ message: "Admission contact deleted" });
  } catch (err) {
    console.error("Error deleting admission contact:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;