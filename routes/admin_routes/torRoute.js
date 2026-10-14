const express = require("express");
const { db3 } = require("../database/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { insertAuditLogAdmission, resolveAuditActor } = require("../../utils/auditLogger");
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

const insertTorAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);
  const roleLabel = formatAuditActorRole(actorRole);
  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message: `${roleLabel} (${actorId}) ${message}`,
  });
};

/* ---------------------------------------------------------------------- */
/*  MULTER — TOR signatory signature images                                */
/* ---------------------------------------------------------------------- */

const torSignatoriesDir = path.join(__dirname, "../../uploads/TOR_Signatories");
if (!fs.existsSync(torSignatoriesDir)) {
  fs.mkdirSync(torSignatoriesDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, torSignatoriesDir),
  filename: (req, file, cb) => {
    const role = (req.params.role || req.body.role || "signatory").toLowerCase();
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${role}_${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});
const uploadSignatoryImage = multer({ storage });

const VALID_ROLES = ["prepared_by", "checked_by", "registrar"];

// GET current TOR settings (single row, id = 1)
router.get("/tor-settings", async (req, res) => {
  try {
    const [rows] = await db3.query(
      `SELECT id, remarks, admission_credentials, credits_note, institution_note,
              institution_website,
              DATE_FORMAT(graduation_date, '%Y-%m-%d') AS graduation_date,
              updated_by, updated_at
       FROM tor_settings WHERE id = 1 LIMIT 1`,
    );
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    console.error("Error fetching TOR settings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// PUT update TOR settings
router.put("/tor-settings", CanEdit, async (req, res) => {
  try {
    const {
      remarks,
      admission_credentials,
      credits_note,
      institution_note,
      institution_website,
      graduation_date, // ✅ NEW
    } = req.body;

    const { actorId } = getAuditActor(req);

    await db3.query(
      `UPDATE tor_settings
       SET remarks = ?,
           admission_credentials = ?,
           credits_note = ?,
           institution_note = ?,
           institution_website = ?,
           graduation_date = ?,
           updated_by = ?
       WHERE id = 1`,
      [
        remarks ?? null,
        admission_credentials ?? null,
        credits_note ?? null,
        institution_note ?? null,
        institution_website ?? null,
        graduation_date ?? null, // ✅ NEW
        actorId,
      ],
    );

    await insertTorAuditLog({
      req,
      action: "TOR_SETTINGS_UPDATE",
      message: "updated the Transcript of Records settings.",
    });

    const [rows] = await db3.query(
      "SELECT * FROM tor_settings WHERE id = 1 LIMIT 1",
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("Error updating TOR settings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});



/* ---------------------------------------------------------------------- */
/*  TOR SIGNATORIES (Prepared By / Checked By / Registrar)                */
/* ---------------------------------------------------------------------- */

// GET all 3 signatories, keyed by role for easy frontend consumption
router.get("/tor-signatories", async (req, res) => {
  try {
    const [rows] = await db3.query("SELECT * FROM tor_signatories");
    const byRole = {};
    for (const role of VALID_ROLES) {
      byRole[role] = rows.find((r) => r.role === role) || null;
    }
    res.json({ success: true, data: byRole });
  } catch (err) {
    console.error("Error fetching TOR signatories:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put(
  "/tor-signatories/:role",
  CanEdit,
  uploadSignatoryImage.single("signature"),
  async (req, res) => {
    try {
      const { role } = req.params;
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: "Invalid role" });
      }

      const { full_name, designation } = req.body;
      // multipart/form-data sends this as a string
      const removeSignature =
        req.body.remove_signature === "true" ||
        req.body.remove_signature === "1" ||
        req.body.remove_signature === true;
      const { actorId } = getAuditActor(req);

      let signaturePath = null;
      let clearSignature = false;

      if (req.file) {
        // New file uploaded — replace whatever's there
        signaturePath = `TOR_Signatories/${req.file.filename}`;

        const [[existing]] = await db3.query(
          "SELECT signature_image FROM tor_signatories WHERE role = ?",
          [role],
        );
        if (existing?.signature_image) {
          const oldPath = path.join(
            __dirname,
            "../../uploads",
            existing.signature_image,
          );
          try {
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          } catch (cleanupErr) {
            console.error("Failed to delete old TOR signatory image:", cleanupErr);
          }
        }
      } else if (removeSignature) {
        // No new file, but the user explicitly asked to remove the existing one
        const [[existing]] = await db3.query(
          "SELECT signature_image FROM tor_signatories WHERE role = ?",
          [role],
        );
        if (existing?.signature_image) {
          const oldPath = path.join(
            __dirname,
            "../../uploads",
            existing.signature_image,
          );
          try {
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          } catch (cleanupErr) {
            console.error("Failed to delete removed TOR signatory image:", cleanupErr);
          }
        }
        clearSignature = true;
      }

      let setClause;
      let values;
      if (signaturePath) {
        setClause = "full_name = ?, designation = ?, signature_image = ?, updated_by = ?";
        values = [full_name ?? "", designation ?? "", signaturePath, actorId, role];
      } else if (clearSignature) {
        setClause = "full_name = ?, designation = ?, signature_image = NULL, updated_by = ?";
        values = [full_name ?? "", designation ?? "", actorId, role];
      } else {
        setClause = "full_name = ?, designation = ?, updated_by = ?";
        values = [full_name ?? "", designation ?? "", actorId, role];
      }

      await db3.query(
        `UPDATE tor_signatories SET ${setClause} WHERE role = ?`,
        values,
      );

      await insertTorAuditLog({
        req,
        action: clearSignature ? "TOR_SIGNATORY_SIGNATURE_REMOVE" : "TOR_SIGNATORY_UPDATE",
        message: clearSignature
          ? `removed the signature image for the TOR ${role.replace("_", " ")} signatory (${full_name || "N/A"}).`
          : `updated the TOR ${role.replace("_", " ")} signatory (${full_name || "N/A"}).`,
      });

      const [[updated]] = await db3.query(
        "SELECT * FROM tor_signatories WHERE role = ?",
        [role],
      );

      res.json({ success: true, data: updated });
    } catch (err) {
      console.error("Error updating TOR signatory:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// GET grade conversion rows flagged for TOR display, in score order
router.get("/tor-grading-system", async (req, res) => {
  try {
    const [rows] = await db3.query(
      `SELECT * FROM grade_conversion
       WHERE show_on_tor = 1
       ORDER BY min_score DESC`,
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Error fetching TOR grading system:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// PUT toggle a single grade_conversion row's visibility on the TOR
router.put("/tor-grading-system/:id/toggle", CanEdit, async (req, res) => {
  try {
    const { id } = req.params;
    const { show_on_tor } = req.body;

    await db3.query(
      "UPDATE grade_conversion SET show_on_tor = ? WHERE id = ?",
      [show_on_tor ? 1 : 0, id],
    );

    await insertTorAuditLog({
      req,
      action: "TOR_GRADING_SYSTEM_TOGGLE",
      message: `${show_on_tor ? "enabled" : "disabled"} grade conversion row #${id} on the TOR grading system.`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error toggling TOR grading system row:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;