const express = require("express");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { db, db3 } = require("../database/database");
const { announcementUpload } = require("../../middleware/uploads");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");
const { notifyAnnouncementChanged } = require("../../socket/socketService");
const {
  CanCreate,
  CanDelete,
  CanEdit,
} = require("../../middleware/pagePermissions");

const uploadDir = path.join(__dirname, "../../uploads/announcement");
fs.mkdirSync(uploadDir, { recursive: true });

const announcementStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `temp_${Date.now()}${path.extname(file.originalname)}`);
  },
});



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

const announcementLabel = (announcement) =>
  announcement?.title ? `"${announcement.title}"` : `Announcement ${announcement?.id || "unknown"}`;

const getCampusLabel = async (campus) => {
  if (!campus) return "All";

  try {
    const [[settings]] = await db.query(
      "SELECT branches FROM company_settings WHERE id = 1 LIMIT 1"
    );
    const branches = settings?.branches ? JSON.parse(settings.branches) : [];
    const branch = branches.find((item) => String(item?.id) === String(campus));

    return (
      branch?.name ||
      branch?.branch_name ||
      branch?.campus ||
      branch?.address ||
      campus
    );
  } catch (err) {
    console.error("Failed to resolve announcement campus label:", err);
    return campus || "All";
  }
};

const insertAnnouncementAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

router.get("/announcements", async (req, res) => {
  try {
    const sql = `
  SELECT 
    id,
    title,
    content,
    valid_days,
    file_path,
    expires_at,
    target_role,
    campus,
    created_at
  FROM announcements
  WHERE expires_at >= NOW() OR expires_at IS NULL
  ORDER BY created_at DESC
`;

    const [rows] = await db.query(sql);
    console.log("Fetched announcements Hello:", rows);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

//EDITED 4:40PM 14/03/2026
router.post("/announcements", CanCreate, announcementUpload.single("image"), async (req, res) => {
  const {
    title,
    content,
    valid_days,
    target_role,
    campus,
  } = req.body;

  if(!title || !content) {
    return res.status(400).json({error: "Missing Required Fields"})
  }

  // ✅ Validate valid_days
  const allowedDays = ["permanent", "1", "3", "7", "14", "30", "60", "90", "120", "180"];
  if (!valid_days || !allowedDays.includes(valid_days.toString())) {
    return res.status(400).json({ error: "Invalid valid_days value" });
  }

  // ✅ Validate target role
  if (!["student", "faculty", "applicant"].includes(target_role)) {
    return res.status(400).json({ error: "Invalid target_role" });
  }

  try {
    // ✅ FIXED SQL (5 columns, 5 values)
  let expiresAt = null;

if (valid_days !== "permanent") {
  expiresAt = valid_days;
}

const [result] = await db.execute(
  `INSERT INTO announcements
   (title, content, valid_days, target_role, campus, expires_at)
   VALUES (?, ?, ?, ?, ?, ${
     expiresAt ? "DATE_ADD(NOW(), INTERVAL ? DAY)" : "NULL"
   })`,
  expiresAt
    ? [title, content, valid_days, target_role, campus || null, valid_days]
    : [title, content, null, target_role, campus || null]
);

    const announcementId = result.insertId;
    let filename = null;

    // ✅ Handle image upload
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      filename = `${announcementId}_announcement${ext}`;

      const oldPath = path.join(__dirname, "../../uploads/Announcement", req.file.filename);
      const newPath = path.join(__dirname, "../../uploads/Announcement", filename);

      fs.renameSync(oldPath, newPath);

      await db.execute(
        "UPDATE announcements SET file_path = ? WHERE id = ?",
        [filename, announcementId]
      );
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const campusLabel = await getCampusLabel(campus);
    await insertAnnouncementAuditLog({
      req,
      action: "ANNOUNCEMENT_CREATE",
      message: `${roleLabel} (${actorId}) created announcement ${announcementLabel({ id: announcementId, title })}. Target: ${target_role}. Campus: ${campusLabel}.`,
    });

    const [[created]] = await db.execute(
      "SELECT * FROM announcements WHERE id = ? LIMIT 1",
      [announcementId],
    );
    notifyAnnouncementChanged("created", created || {
      id: announcementId,
      title,
      content,
      valid_days,
      target_role,
      campus,
      file_path: filename,
    });

    res.json({
      message: "Announcement created",
      id: announcementId,
      file: filename,
    });

  } catch (err) {
    console.error("Error inserting announcement:", err);
    res.status(500).json({ error: "Database error" });
  }
}
);
//EDITED 4:40PM 14/03/2026
router.put("/announcements/:id", CanEdit, announcementUpload.single("image"), async (req, res) => {
  const { id } = req.params;
  const { title, content, valid_days, target_role, campus } = req.body;

  if(!title || !content) {
    return res.status(400).json({message: "Missing Required Fields"})
  }

  const allowedDays = ["permanent", "1", "3", "7", "14", "30", "60", "90", "120", "180"];

  if (!valid_days || !allowedDays.includes(valid_days.toString())) {
    return res.status(400).json({ error: "Invalid valid_days value" });
  }

  if (!["student", "faculty", "applicant"].includes(target_role)) {
    return res.status(400).json({ error: "Invalid target_role" });
  }

  try {
    const [[announcementBefore]] = await db.execute(
      "SELECT id, title, target_role, campus FROM announcements WHERE id = ? LIMIT 1",
      [id],
    );

    let query;
    let params;

    // ✅ Handle Permanent
    if (valid_days === "permanent") {
      query = `
        UPDATE announcements
        SET title = ?, content = ?, valid_days = NULL, target_role = ?, campus = ?, expires_at = NULL
        WHERE id = ?
      `;

      params = [title, content, target_role, campus || null, id];

    } else {

      // ✅ Handle Normal Days
      query = `
        UPDATE announcements
        SET title = ?, content = ?, valid_days = ?, target_role = ?, campus = ?,
            expires_at = DATE_ADD(NOW(), INTERVAL ? DAY)
        WHERE id = ?
      `;

      params = [title, content, valid_days, target_role, campus || null, valid_days, id];
    }

    const [result] = await db.execute(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Announcement not found" });
    }

    // ✅ Handle Image Update
    if (req.file) {

      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `${id}_announcement${ext}`;

      const oldPath = path.join(__dirname, "../../uploads/Announcement", req.file.filename);
      const newPath = path.join(__dirname, "../../uploads/Announcement", filename);

      fs.renameSync(oldPath, newPath);

      await db.execute(
        "UPDATE announcements SET file_path = ? WHERE id = ?",
        [filename, id]
      );
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const campusLabel = await getCampusLabel(campus);
    await insertAnnouncementAuditLog({
      req,
      action: "ANNOUNCEMENT_UPDATE",
      message: `${roleLabel} (${actorId}) updated announcement ${announcementLabel(announcementBefore)} to ${announcementLabel({ id, title })}. Target: ${target_role}. Campus: ${campusLabel}.`,
    });

    const [[updated]] = await db.execute(
      "SELECT * FROM announcements WHERE id = ? LIMIT 1",
      [id],
    );
    notifyAnnouncementChanged("updated", updated || {
      id,
      title,
      content,
      valid_days,
      target_role,
      campus,
    });

    res.json({ message: "Announcement updated successfully" });

  } catch (err) {
    console.error("Error updating announcement:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/announcements/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[announcementBefore]] = await db.execute(
      "SELECT id, title, target_role, campus FROM announcements WHERE id = ? LIMIT 1",
      [id],
    );

    const [result] = await db.execute(
      "DELETE FROM announcements WHERE id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Announcement not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertAnnouncementAuditLog({
      req,
      action: "ANNOUNCEMENT_DELETE",
      message: `${roleLabel} (${actorId}) deleted announcement ${announcementLabel(announcementBefore)}.`,
    });

    notifyAnnouncementChanged("deleted", {
      id: Number(id),
      ...(announcementBefore || {}),
    });

    res.json({ message: "Announcement deleted" });
  } catch (err) {
    console.error("Error deleting announcement:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/announcements/student", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM announcements 
       WHERE target_role = 'student'
       AND (expires_at > NOW() OR expires_at IS NULL)
       ORDER BY created_at DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching student announcements:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/announcements/faculty", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM announcements 
       WHERE target_role = 'faculty'
       AND (expires_at > NOW() OR expires_at IS NULL)
       ORDER BY created_at DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching faculty announcements:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/announcements/applicant", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM announcements 
       WHERE target_role = 'applicant'
       AND (expires_at > NOW() OR expires_at IS NULL)
       ORDER BY created_at DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching applicant announcements:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/announcements/user/:email", async (req, res) => {
  const { email } = req.params;

  try {

    // 1️⃣ get role from db3
    const [users] = await db3.execute(
      "SELECT role FROM user_accounts WHERE email = ?",
      [email]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const role = users[0].role;

    // 2️⃣ fetch announcements for that role
    const [announcements] = await db.execute(
      `SELECT *
       FROM announcements
       WHERE target_role = ?
       AND (expires_at > NOW() OR expires_at IS NULL)
       ORDER BY created_at DESC`,
      [role]
    );

    res.json({
      role: role,
      announcements: announcements
    });

  } catch (err) {
    console.error("Error fetching announcements:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
