const express = require("express");
const { db, db3 } = require("../database/database");
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

const getProfessorEducationLabel = async (personId) => {
  try {
    const [rows] = await db3.query(
      "SELECT employee_id, fname, mname, lname, email FROM prof_table WHERE prof_id = ? LIMIT 1",
      [personId],
    );
    const prof = rows?.[0];
    if (!prof) return `prof_id ${personId}`;
    const name = [prof.lname, prof.fname, prof.mname].filter(Boolean).join(", ");
    return prof.employee_id || name || prof.email || `prof_id ${personId}`;
  } catch (err) {
    console.error("Professor education audit lookup failed:", err);
    return `prof_id ${personId}`;
  }
};

const insertProfessorEducationAuditLog = async ({ req, action, message, severity = "INFO" }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity,
    message,
  });
};

router.get("/prof_dropdown", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT prof_id AS person_id, fname, mname, lname, employee_id
      FROM prof_table
      WHERE status = 1
      ORDER BY lname, fname
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching prof dropdown:", err);
    res.status(500).json({ message: "Failed to fetch professors" });
  }
});

router.get("/person_prof_list", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT
        p.person_id,
        pr.fname,
        pr.mname,
        pr.lname,
        pr.employee_id,
        p.bachelor,
        p.master,
        p.doctor
      FROM person_prof_table p
      LEFT JOIN prof_table pr
        ON pr.prof_id = p.person_id
      ORDER BY pr.lname, pr.fname
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching joined person_prof:", err);
    res.status(500).json({ message: "Failed to fetch records" });
  }
});


router.post("/person_prof", async (req, res) => {
  const { person_id, bachelor, master, doctor } = req.body;

  try {
    const [existing] = await db3.query(
      "SELECT 1 FROM person_prof_table WHERE person_id = ?",
      [person_id],
    );

    if (existing.length > 0) {
      return res.status(409).json({ message: "Record already exists" });
    }

    await db3.query(
      `INSERT INTO person_prof_table
       (person_id, bachelor, master, doctor)
       VALUES (?, ?, ?, ?)`,
      [person_id, bachelor || null, master || null, doctor || null],
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const professorLabel = await getProfessorEducationLabel(person_id);
    await insertProfessorEducationAuditLog({
      req,
      action: "PROFESSOR_EDUCATION_CREATE",
      message: `${roleLabel} (${actorId}) created professor education record for Professor (${professorLabel}).`,
    });

    res.json({ message: "Education record added" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add record" });
  }
});

router.put("/person_prof/:person_id", async (req, res) => {
  const { person_id } = req.params;
  const { bachelor, master, doctor } = req.body;

  try {
    const [result] = await db3.query(
      `UPDATE person_prof_table
       SET bachelor = ?, master = ?, doctor = ?
       WHERE person_id = ?`,
      [bachelor || null, master || null, doctor || null, person_id],
    );

    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const professorLabel = await getProfessorEducationLabel(person_id);
      await insertProfessorEducationAuditLog({
        req,
        action: "PROFESSOR_EDUCATION_UPDATE",
        message: `${roleLabel} (${actorId}) updated professor education record for Professor (${professorLabel}).`,
      });
    }

    res.json({ message: "Education record updated" });
  } catch (err) {
    console.error("Error updating person_prof:", err);
    res.status(500).json({ message: "Failed to update record" });
  }
});

router.delete("/person_prof/:person_id", async (req, res) => {
  const { person_id } = req.params;

  try {
    const professorLabel = await getProfessorEducationLabel(person_id);
    const [result] = await db3.query("DELETE FROM person_prof_table WHERE person_id = ?", [
      person_id,
    ]);
    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      await insertProfessorEducationAuditLog({
        req,
        action: "PROFESSOR_EDUCATION_DELETE",
        severity: "WARN",
        message: `${roleLabel} (${actorId}) deleted professor education record for Professor (${professorLabel}).`,
      });
    }
    res.json({ message: "Education record deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete record" });
  }
});

module.exports = router
