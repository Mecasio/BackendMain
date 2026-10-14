const express = require('express');
const { db, db3 } = require('../database/database');
const { CanCreate, CanEdit, CanDelete } = require('../../middleware/pagePermissions');
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

const getCourseLabel = (course) => {
  if (!course) return "Unknown Course";
  const code = course.course_code || "N/A";
  const description = course.course_description || "Untitled Course";
  return `${code} - ${description}`;
};

const insertCoursePanelAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

/* ===================== GET COURSE LIST ===================== */
router.get("/course_list", async (req, res) => {
  const query = `
    SELECT
      c.*,
      st.subject_type_name,
      ct.category_type_name
    FROM course_table c
    LEFT JOIN subject_type_table st ON c.subject_type_id = st.subject_type_id
    LEFT JOIN category_type_table ct ON c.category_type_id = ct.category_type_id
    ORDER BY c.course_code ASC
  `;

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

router.post("/adding_course", CanCreate, async (req, res) => {
  const {
    course_code,
    course_description,
    course_unit,
    lec_unit,
    lab_unit,
    prereq,
    corequisite,
    subject_type_id,
    category_type_id,
    is_academic_achiever,
    is_latin,
    is_gwa_included
  } = req.body;

  try {
    const normalizeCode = (code) =>
      (code || "")
        .replace(/[^A-Za-z0-9-_\. ]/g, "")
        .replace(/(\S) +(\S)/g, "$1 $2")
        .replace(/^ +| +$/g, "")
        .toUpperCase();

    const normalizeDescription = (desc) => (desc || "").trim();

    const normalized_code = normalizeCode(course_code);
    const normalized_desc = normalizeDescription(course_description);

    const unit = parseFloat(course_unit) || 0;
    const lec = parseFloat(lec_unit) || 0;
    const lab = parseFloat(lab_unit) || 0;

    const subjectTypeId = subject_type_id ? Number(subject_type_id) : 1;
    const categoryTypeId = category_type_id ? Number(category_type_id) : 1;

    if (!normalized_code) {
      return res.status(400).json({ message: "Course code is required" });
    }

    if (!normalized_desc) {
      return res.status(400).json({ message: "Course description is required" });
    }

    const [rows] = await db3.query(
      `SELECT course_id FROM course_table 
   WHERE course_code = ?
   AND course_description = ?
   AND course_unit = ?
   AND lec_unit = ?
   AND lab_unit = ?
   AND (prereq <=> ?)
   AND (corequisite <=> ?)
   AND (is_academic_achiever <=> ?)
   AND (is_latin <=> ?)
   AND (is_gwa_included <=> ?)`,
      [
        normalized_code,
        normalized_desc,
        unit,
        lec,
        lab,
        prereq || null,
        corequisite || null,
        is_academic_achiever ?? 1,
        is_latin ?? 1,
        is_gwa_included ?? 1,
      ]
    );

    if (rows.length > 0) {
      return res.status(400).json({
        message: "❌ Exact duplicate course already exists",
      });
    }

    await db3.query(
      `INSERT INTO course_table
    (
      course_code,
      course_description,
      course_unit,
      lec_unit,
      lab_unit,
      prereq,
      corequisite,
      subject_type_id,
      category_type_id,
      is_academic_achiever,
      is_latin,
      is_gwa_included
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized_code,
        normalized_desc,
        unit,
        lec,
        lab,
        prereq || null,
        corequisite || null,
        subjectTypeId,
        categoryTypeId,
        is_academic_achiever ?? 1,
        is_latin ?? 1,
        is_gwa_included ?? 1
      ]
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertCoursePanelAuditLog({
      req,
      action: "COURSE_CREATE",
      message: `${roleLabel} (${actorId}) created course ${normalized_code} - ${normalized_desc}.`,
    });

    res.status(200).json({ message: "✅ Course added successfully" });

  } catch (error) {
    console.error("❌ Error adding course:", error);
    res.status(500).json({ message: "Failed to add course" });
  }
});

router.put("/update_course/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const {
    course_code,
    course_description,
    course_unit,
    lec_unit,
    lab_unit,
    prereq,
    corequisite,
    subject_type_id,
    category_type_id,
    is_academic_achiever,
    is_latin,
    is_gwa_included
  } = req.body;

  try {
    const [currentRows] = await db3.query(
      "SELECT * FROM course_table WHERE course_id = ?",
      [id]
    );

    if (currentRows.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    const current = currentRows[0];

    const normalizeCode = (code) =>
      (code || "")
        .replace(/[^A-Za-z0-9-_\. ]/g, "")
        .replace(/(\S) +(\S)/g, "$1 $2")
        .replace(/^ +| +$/g, "")
        .toUpperCase();

    const normalizeDescription = (desc) => (desc || "").trim();

    const final_course_code = course_code
      ? normalizeCode(course_code)
      : normalizeCode(current.course_code);

    const final_course_desc = course_description
      ? normalizeDescription(course_description)
      : normalizeDescription(current.course_description);

    const final_subject_type_id =
      subject_type_id !== undefined && subject_type_id !== ""
        ? Number(subject_type_id)
        : current.subject_type_id;

    const final_category_type_id =
      category_type_id !== undefined && category_type_id !== ""
        ? Number(category_type_id)
        : current.category_type_id;

    const [rows] = await db3.query(
      `SELECT course_id FROM course_table 
   WHERE course_code = ?
   AND course_description = ?
   AND course_unit = ?
   AND lec_unit = ?
   AND lab_unit = ?
   AND (prereq <=> ?)
   AND (corequisite <=> ?)
   AND (is_academic_achiever <=> ?)
   AND (is_latin <=> ?)
   AND (is_gwa_included <=> ?)
   AND course_id != ?`,
      [
        final_course_code,
        final_course_desc,
        course_unit !== undefined && course_unit !== ""
          ? parseFloat(course_unit)
          : current.course_unit,
        lec_unit !== undefined && lec_unit !== ""
          ? parseFloat(lec_unit)
          : current.lec_unit,
        lab_unit !== undefined && lab_unit !== ""
          ? parseFloat(lab_unit)
          : current.lab_unit,
        prereq ?? current.prereq,
        corequisite ?? current.corequisite,
        is_academic_achiever ?? current.is_academic_achiever,
        is_latin ?? current.is_latin,
        is_gwa_included ?? current.is_gwa_included,
        id,
      ]
    );

    if (rows.length > 0) {
      return res.status(400).json({ message: "The course already exists" });
    }

    await db3.query(
      `UPDATE course_table SET
    course_code = ?,
    course_description = ?,
    course_unit = ?,
    lec_unit = ?,
    lab_unit = ?,
    prereq = ?,
    corequisite = ?,
    subject_type_id = ?,
    category_type_id = ?,
    is_academic_achiever = ?,
    is_latin = ?,
    is_gwa_included = ?
  WHERE course_id = ?`,
      [
        final_course_code,
        final_course_desc,
        course_unit !== undefined && course_unit !== ""
          ? parseFloat(course_unit)
          : current.course_unit,
        lec_unit !== undefined ? parseFloat(lec_unit) : current.lec_unit,
        lab_unit !== undefined ? parseFloat(lab_unit) : current.lab_unit,
        prereq !== undefined ? prereq : current.prereq,
        corequisite !== undefined ? corequisite : current.corequisite,
        final_subject_type_id,
        final_category_type_id,
        is_academic_achiever ?? current.is_academic_achiever,
        is_latin ?? current.is_latin,
        is_gwa_included ?? current.is_gwa_included,
        id,
      ]
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertCoursePanelAuditLog({
      req,
      action: "COURSE_UPDATE",
      message: `${roleLabel} (${actorId}) updated course ${getCourseLabel({
        course_code: final_course_code,
        course_description: final_course_desc,
      })}.`,
    });

    res.json({ message: "✅ Course updated successfully" });
  } catch (error) {
    console.error("❌ Error updating course:", error);
    res.status(500).json({ message: "Failed to update course" });
  }
});

router.put("/update_course_requirements/:id", CanEdit, async (req, res) => {
  const { id } = req.params;
  const { prereq, corequisite } = req.body;

  try {
    const [currentRows] = await db3.query(
      "SELECT course_code, course_description FROM course_table WHERE course_id = ? LIMIT 1",
      [id],
    );

    if (currentRows.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    await db3.query(
      "UPDATE course_table SET prereq = ?, corequisite = ? WHERE course_id = ?",
      [prereq || null, corequisite || null, id],
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertCoursePanelAuditLog({
      req,
      action: "COURSE_REQUIREMENTS_UPDATE",
      message: `${roleLabel} (${actorId}) updated prerequisites/corequisites for ${getCourseLabel(currentRows[0])}.`,
    });

    res.json({ message: "Course requirements updated successfully" });
  } catch (error) {
    console.error("Error updating course requirements:", error);
    res.status(500).json({ message: "Failed to update course requirements" });
  }
});

router.delete("/delete_course/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [courseRows] = await db3.query(
      "SELECT course_code, course_description FROM course_table WHERE course_id = ? LIMIT 1",
      [id]
    );

    const [result] = await db3.query(
      "DELETE FROM course_table WHERE course_id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertCoursePanelAuditLog({
      req,
      action: "COURSE_DELETE",
      message: `${roleLabel} (${actorId}) deleted course ${getCourseLabel(courseRows[0])}.`,
    });

    res.json({ message: "✅ Course deleted successfully" });
  } catch (error) {
    console.error("❌ Error deleting course:", error);
    res.status(500).json({ message: "Failed to delete course" });
  }
});

module.exports = router;