const express = require("express");
const { db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");
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

const programLabel = (program) => {
  if (!program) return "Unknown Program";

  const code = program.program_code || program.code || "N/A";
  const description =
    program.program_description || program.name || "Unknown Program";
  const major = program.major ? ` (${program.major})` : "";

  return `${code} - ${description}${major}`;
};

const insertProgramAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

// ---------------------------- CREATE PROGRAM ----------------------------------
router.post("/program", CanCreate, async (req, res) => {
  const { name, code, major, components, academic_program } = req.body;

  try {
    const [result] = await db3.query(
      `INSERT INTO program_table 
   (program_description, program_code, major, components, academic_program)
   VALUES (?, ?, ?, ?, ?)`,
      [name, code, major, components, academic_program],
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertProgramAuditLog({
      req,
      action: "PROGRAM_CREATE",
      message: `${roleLabel} (${actorId}) created program ${programLabel({
        code,
        name,
        major,
      })}. Program ID: ${result.insertId}.`,
    });

    res.status(200).json({ message: "Program created successfully" });
  } catch (err) {
    console.error("Error creating program:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// -------------------- GET PROGRAMS --------------------
router.get("/get_program", async (req, res) => {
  try {
    const [result] = await db3.query("SELECT * FROM program_table");
    res.status(200).send(result);
  } catch (err) {
    console.error("Error fetching programs:", err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

// -------------------- UPDATE PROGRAM --------------------
router.put("/program/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { name, code, major, components, academic_program } = req.body;

  try {
    const [[programBefore]] = await db3.query(
      `SELECT program_id, program_description, program_code, major
       FROM program_table
       WHERE program_id = ?
       LIMIT 1`,
      [id],
    );

    const [result] = await db3.query(
      `UPDATE program_table
 SET program_description = ?, 
     program_code = ?, 
     major = ?, 
     components = ?,
     academic_program = ?
 WHERE program_id = ?`,
      [name, code, major, components, academic_program, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Program not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertProgramAuditLog({
      req,
      action: "PROGRAM_UPDATE",
      message: `${roleLabel} (${actorId}) updated program ${programLabel(
        programBefore,
      )} to ${programLabel({ code, name, major })}.`,
    });

    res.json({ message: "Program updated successfully" });
  } catch (err) {
    console.error("Error updating program:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// -------------------- DELETE PROGRAM --------------------
router.delete("/program/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[programBefore]] = await db3.query(
      `SELECT program_id, program_description, program_code, major
       FROM program_table
       WHERE program_id = ?
       LIMIT 1`,
      [id],
    );

    const [result] = await db3.query(
      "DELETE FROM program_table WHERE program_id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Program not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertProgramAuditLog({
      req,
      action: "PROGRAM_DELETE",
      message: `${roleLabel} (${actorId}) deleted program ${programLabel(
        programBefore,
      )}.`,
    });

    res.status(200).send({ message: "Program deleted successfully" });
  } catch (err) {
    console.error("Error deleting program:", err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

// -------------------- SUPERADMIN UPDATE PROGRAM --------------------
router.put("/update_program/:id", async (req, res) => {
  const { id } = req.params;
  const { name, code, major, components, academic_program } = req.body;

  try {
    const [result] = await db3.query(
      `UPDATE program_table 
       SET program_description = ?, 
           program_code = ?, 
           major = ?, 
           components = ?
       WHERE program_id = ?`,
      [name, code, major, components, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Program not found" });
    }

    res.status(200).send({ message: "Program updated successfully" });
  } catch (err) {
    console.error("Error updating program:", err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

// -------------------- SUPERADMIN DELETE PROGRAM --------------------
router.delete("/delete_program/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db3.query(
      "DELETE FROM program_table WHERE program_id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).send({ message: "Program not found" });
    }

    res.status(200).send({ message: "Program deleted successfully" });
  } catch (err) {
    console.error("Error deleting program:", err);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

module.exports = router;
