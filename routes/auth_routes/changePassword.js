const express = require("express");
const { db, db3 } = require("../database/database");
const bcrypt = require("bcryptjs");
const {
  insertAuditLogAdmission,
  insertAuditLogEnrollment,
} = require("../../utils/auditLogger");
const { resolveUserMacAddress } = require("../../utils/macAddress");
const router = express.Router();

const buildPersonDisplayName = (row = {}) => {
  const fullName = [
    row.first_name || row.fname,
    row.middle_name || row.mname,
    row.last_name || row.lname,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || row.email || "Unknown User";
};

const insertOwnPasswordAuditLog = async ({
  auditDb,
  actorId,
  role,
  action,
  message,
  userMacAddress,
}) => {
  const auditLogger =
    auditDb === "db" ? insertAuditLogAdmission : insertAuditLogEnrollment;

  await auditLogger({
    actorId: actorId || "unknown",
    role,
    action,
    severity: "INFO",
    message:
      message ||
      `${role || "User"} (${actorId || "unknown"}) reset own account password.`,
    userMacAddress,
  });
};

// Applicant Change Password
router.post("/applicant-change-password", async (req, res) => {
  const { person_id, currentPassword, newPassword } = req.body;
  if (!person_id || !currentPassword || !newPassword)
    return res.status(400).json({ message: "All fields are required" });
  try {
    const [rows] = await db.query("SELECT * FROM user_accounts WHERE person_id = ?", [person_id]);
    if (!rows.length) return res.status(404).json({ message: "User not found" });
    const user = rows[0];
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(401).json({ message: "Current password is incorrect" });
    const strong = newPassword.length >= 8 && /[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) && /\d/.test(newPassword) && /^[\s\S]*[!#$^*@\-.<>_&%+=?][\s\S]*$/.test(newPassword);
    if (!strong) return res.status(400).json({ message: "New password does not meet complexity requirements" });
    const hashed = await bcrypt.hash(newPassword, 10);
    // ✅ Clear force_password_change
    await db.query(
      "UPDATE user_accounts SET password = ?, force_password_change = 0 WHERE person_id = ?",
      [hashed, person_id]
    );
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password update error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Registrar Change Password
router.post("/registrar-change-password", async (req, res) => {
  const { person_id, currentPassword, newPassword } = req.body;
  if (!person_id || !currentPassword || !newPassword)
    return res.status(400).json({ message: "All fields are required" });
  try {
    const [rows] = await db3.query("SELECT * FROM user_accounts WHERE person_id = ?", [person_id]);
    if (!rows.length) return res.status(404).json({ message: "User not found" });
    const user = rows[0];
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(401).json({ message: "Current password is incorrect" });
    const strong = newPassword.length >= 8 && /[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) && /\d/.test(newPassword) && /^[\s\S]*[!#$^*@\-.<>_&%+=?][\s\S]*$/.test(newPassword);
    if (!strong) return res.status(400).json({ message: "New password does not meet complexity requirements" });
    const hashed = await bcrypt.hash(newPassword, 10);
    // ✅ Clear force_password_change
    await db3.query(
      "UPDATE user_accounts SET password = ?, force_password_change = 0 WHERE person_id = ?",
      [hashed, person_id]
    );
    await insertOwnPasswordAuditLog({ auditDb: "db3", actorId: user.employee_id || user.email || person_id, role: user.role || "registrar", action: "REGISTRAR_OWN_PASSWORD_RESET" });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password update error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Student Change Password
router.post("/student-change-password", async (req, res) => {
  const { person_id, currentPassword, newPassword } = req.body;
  if (!person_id || !currentPassword || !newPassword)
    return res.status(400).json({ message: "All fields are required" });
  try {
    const [rows] = await db3.query("SELECT * FROM user_accounts WHERE person_id = ?", [person_id]);
    if (!rows.length) return res.status(404).json({ message: "User not found" });
    const user = rows[0];
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(401).json({ message: "Current password is incorrect" });
    const strong = newPassword.length >= 8 && /[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) && /\d/.test(newPassword) && /^[\s\S]*[!#$^*@\-.<>_&%+=?][\s\S]*$/.test(newPassword);
    if (!strong) return res.status(400).json({ message: "New password does not meet complexity requirements" });
    const hashed = await bcrypt.hash(newPassword, 10);
    // ✅ Clear force_password_change
    await db3.query(
      "UPDATE user_accounts SET password = ?, force_password_change = 0 WHERE person_id = ?",
      [hashed, person_id]
    );
    let studentActorId = user.employee_id || user.email || person_id;
    try {
      const [studentRows] = await db3.query("SELECT student_number FROM student_numbering_table WHERE person_id = ? LIMIT 1", [person_id]);
      studentActorId = studentRows?.[0]?.student_number || studentActorId;
    } catch (lookupError) { console.error("Student password audit lookup failed:", lookupError); }
    await insertOwnPasswordAuditLog({ auditDb: "db3", actorId: studentActorId, role: user.role || "student", action: "STUDENT_OWN_PASSWORD_RESET" });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password update error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


// Faculty Change Password
router.post("/faculty-change-password", async (req, res) => {
  const { employee_id, currentPassword, newPassword } = req.body;
  if (!employee_id || !currentPassword || !newPassword)
    return res.status(400).json({ message: "All fields are required" });
  try {
    const [rows] = await db3.query("SELECT * FROM prof_table WHERE employee_id = ?", [employee_id]);
    if (!rows.length) return res.status(404).json({ message: "User not found" });
    const user = rows[0];
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(401).json({ message: "Current password is incorrect" });
    const strong = newPassword.length >= 8 && /[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) && /\d/.test(newPassword) && /^[\s\S]*[!#$^*@\-.<>_&%+=?][\s\S]*$/.test(newPassword);
    if (!strong) return res.status(400).json({ message: "New password does not meet complexity requirements" });
    const hashed = await bcrypt.hash(newPassword, 10);
    // ✅ Clear force_password_change
    await db3.query(
      "UPDATE prof_table SET password = ?, force_password_change = 0 WHERE employee_id = ?",
      [hashed, employee_id]
    );
    const displayName = buildPersonDisplayName(user);
    const accountEmail = user.email || "unknown";
    const userMacAddress = await resolveUserMacAddress(req);
    await insertOwnPasswordAuditLog({
      auditDb: "db3",
      actorId: user.employee_id || user.email || employee_id,
      role: user.role || "faculty",
      action: "FACULTY_OWN_PASSWORD_RESET",
      message: `The user ${displayName} ${accountEmail} reset the password.`,
      userMacAddress,
    });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password update error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


module.exports = router
