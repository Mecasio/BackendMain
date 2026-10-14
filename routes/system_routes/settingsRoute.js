const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { db } = require("../database/database");
const {
  insertAuditLogAdmission,
  resolveAuditActor,
} = require("../../utils/auditLogger");
const { syncBranchesOpenStatus } = require("../../utils/registrationWindow");
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

const insertSettingsAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogAdmission({
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

/* ===================== FILE UPLOAD ===================== */

const allowedExtensions = [".png", ".jpg", ".jpeg", ".pdf"];
const uploadsRoot = path.join(__dirname, "..", "..", "uploads");

const settingsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(uploadsRoot)) {
      fs.mkdirSync(uploadsRoot, { recursive: true });
    }
    cb(null, uploadsRoot);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.includes(ext)) {
      return cb(
        new Error("Invalid file type. Only PNG, JPG, JPEG, or PDF allowed."),
      );
    }

    if (file.fieldname === "logo") cb(null, "Logo" + ext);
    else if (file.fieldname === "bg_image") cb(null, "Background" + ext);
    else cb(null, Date.now() + ext);
  },
});

const settingsUpload = multer({ storage: settingsStorage });

/* ===================== DELETE OLD FILE ===================== */

const deleteOldFile = (fileUrl) => {
  if (!fileUrl) return;

  const filePath = path.join(__dirname, "..", "..", fileUrl.replace(/^\//, ""));
  fs.unlink(filePath, (err) => {
    if (err) console.error(`Error deleting old file: ${err.message}`);
    else console.log(`Deleted old file: ${filePath}`);
  });
};

const parseSettingsRow = (settings) => {
  if (!settings) return null;

  const normalized = { ...settings };
  if (normalized.branches) {
    try {
      normalized.branches = JSON.parse(normalized.branches);
    } catch (err) {
      normalized.branches = [];
    }
  } else {
    normalized.branches = [];
  }

  return normalized;
};

const getOrCreateSettingsRow = async () => {
  const [rows] = await db.query("SELECT * FROM company_settings WHERE id = 1");
  if (rows.length > 0) return parseSettingsRow(rows[0]);

  await db.query("INSERT INTO company_settings (id, branches) VALUES (1, ?)", [
    "[]",
  ]);

  const [createdRows] = await db.query(
    "SELECT * FROM company_settings WHERE id = 1",
  );
  return parseSettingsRow(createdRows[0]);
};

/* ===================== GET SETTINGS ===================== */

router.get("/settings", async (req, res) => {
  try {
    const settings = await getOrCreateSettingsRow();
    res.json(settings);
  } catch (err) {
    console.error("❌ Error fetching settings:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== SAVE SETTINGS ===================== */

router.post(
  "/settings",
  settingsUpload.fields([
    { name: "logo", maxCount: 1 },
    { name: "bg_image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        company_name,
        short_term,
        address,
        header_color,
        footer_text,
        footer_color,
        main_button_color,
        sub_button_color,
        border_color,
        stepper_color,
        sidebar_button_color,
        title_color,
        subtitle_color,
        branches,
      } = req.body;

      const logoUrl = req.files?.logo
        ? `/uploads/${req.files.logo[0].filename}`
        : null;

      const bgImageUrl = req.files?.bg_image
        ? `/uploads/${req.files.bg_image[0].filename}`
        : null;

      const [rows] = await db.query(
        "SELECT * FROM company_settings WHERE id = 1",
      );

      let parsedBranches = "[]";
      if (typeof branches !== "undefined") {
        try {
          parsedBranches = Array.isArray(branches)
            ? JSON.stringify(branches)
            : JSON.stringify(JSON.parse(branches));
        } catch (err) {
          parsedBranches = "[]";
        }
      }

      if (rows.length > 0) {
        const currentSettings = rows[0];
        const oldLogo = currentSettings.logo_url;
        const oldBg = currentSettings.bg_image;

        if (typeof branches === "undefined") {
          parsedBranches = currentSettings.branches || "[]";
        }

        let query = `
          UPDATE company_settings
          SET
            company_name=?,
            short_term=?,
            address=?,
            header_color=?,
            footer_text=?,
            footer_color=?,
            main_button_color=?,
            sub_button_color=?,
            border_color=?,
            stepper_color=?,
            sidebar_button_color=?,
            title_color=?,
            subtitle_color=?,
            branches=?`;

        const params = [
          company_name ?? currentSettings.company_name ?? "",
          short_term ?? currentSettings.short_term ?? "",
          address ?? currentSettings.address ?? "",
          header_color ?? currentSettings.header_color ?? "#ffffff",
          footer_text ?? currentSettings.footer_text ?? "",
          footer_color ?? currentSettings.footer_color ?? "#ffffff",
          main_button_color ?? currentSettings.main_button_color ?? "#ffffff",
          sub_button_color ?? currentSettings.sub_button_color ?? "#ffffff",
          border_color ?? currentSettings.border_color ?? "#000000",
          stepper_color ?? currentSettings.stepper_color ?? "#000000",
          sidebar_button_color ??
            currentSettings.sidebar_button_color ??
            "#000000",
          title_color ?? currentSettings.title_color ?? "#000000",
          subtitle_color ?? currentSettings.subtitle_color ?? "#555555",
          parsedBranches,
        ];

        if (logoUrl) {
          query += ", logo_url=?";
          params.push(logoUrl);
        }

        if (bgImageUrl) {
          query += ", bg_image=?";
          params.push(bgImageUrl);
        }

        query += " WHERE id = 1";

        await db.query(query, params);

        const { actorId, roleLabel } = getActorLabel(req);
        await insertSettingsAuditLog({
          req,
          action: "SYSTEM_SETTINGS_UPDATE",
          message: `${roleLabel} (${actorId}) updated system settings.`,
        });

        if (logoUrl && oldLogo && oldLogo !== logoUrl) deleteOldFile(oldLogo);
        if (bgImageUrl && oldBg && oldBg !== bgImageUrl) deleteOldFile(oldBg);

        return res.json({
          success: true,
          message: "Settings updated successfully.",
        });
      }

      const insertQuery = `
        INSERT INTO company_settings
        (
          company_name, short_term, address, header_color, footer_text, footer_color,
          logo_url, bg_image,
          main_button_color, sub_button_color, border_color, stepper_color, sidebar_button_color,
          title_color, subtitle_color,
          branches
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      await db.query(insertQuery, [
        company_name || "",
        short_term || "",
        address || "",
        header_color || "#ffffff",
        footer_text || "",
        footer_color || "#ffffff",
        logoUrl,
        bgImageUrl,
        main_button_color || "#ffffff",
        sub_button_color || "#ffffff",
        border_color || "#000000",
        stepper_color || "#000000",
        sidebar_button_color || "#000000",
        title_color || "#000000",
        subtitle_color || "#555555",
        parsedBranches,
      ]);

      const { actorId, roleLabel } = getActorLabel(req);
      await insertSettingsAuditLog({
        req,
        action: "SYSTEM_SETTINGS_CREATE",
        message: `${roleLabel} (${actorId}) created system settings.`,
      });

      res.json({ success: true, message: "Settings created successfully." });
    } catch (err) {
      console.error("❌ Error in /settings:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.get("/branches", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT branches FROM company_settings WHERE id = 1",
    );

    if (rows.length === 0) {
      return res.json([]);
    }

    let branches = [];

    try {
      branches = rows[0].branches ? JSON.parse(rows[0].branches) : [];
    } catch (err) {
      console.error("JSON PARSE ERROR:", err);
      branches = [];
    }

    // ✅ ensure ALL branches have academicPrograms
    branches = branches.map((b) => ({
      ...b,
      academicPrograms: (b.academicPrograms || [
        { id: 0, name: "Undergraduate", open: 1 },
        { id: 1, name: "Graduate", open: 0 },
        { id: 2, name: "Techvoc", open: 0 },
      ]).map((program) => ({
        ...program,
        all_programs: Number(program.all_programs) === 1 ? 1 : 0,
      })),
    }));

    // ── NEW: live-sync registration_open against the current time ──
    // If any branch's stored flag disagrees with what the schedule says
    // it should be right now, correct it and persist the correction.
    // This is what makes the admin dashboard "self-heal" even if nobody
    // opens this page exactly at the cutoff moment — the next request
    // (admin or applicant side) catches up the DB automatically.
    const { branches: syncedBranches, changed } =
      syncBranchesOpenStatus(branches);

    if (changed) {
      await db.query("UPDATE company_settings SET branches = ? WHERE id = 1", [
        JSON.stringify(syncedBranches),
      ]);
      console.log(
        "🔄 Auto-synced registration_open for one or more branches based on schedule.",
      );
    }

    res.json(syncedBranches);
  } catch (err) {
    console.error("GET ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

router.post("/branches", async (req, res) => {
  const { branch, address } = req.body;

  if (!branch || !address) {
    return res.status(400).json({ message: "Branch and address required" });
  }

  try {
    const [rows] = await db.query(
      "SELECT branches FROM company_settings WHERE id = 1",
    );

    let branches = [];

    if (rows.length > 0 && rows[0].branches) {
      branches = JSON.parse(rows[0].branches);
    }

    const maxId =
      branches.length > 0 ? Math.max(...branches.map((b) => Number(b.id))) : 0;

    const newBranch = {
      id: maxId + 1,
      branch,
      address,
      registration_open: 0,
      start_date: null,
      end_date: null,

      start_time: null,
      end_time: null,

      // ✅ INCLUDED
      academicPrograms: [
        { id: 0, name: "Undergraduate", open: 1, all_programs: 0 },
        { id: 1, name: "Graduate", open: 0, all_programs: 0 },
        { id: 2, name: "Techvoc", open: 0, all_programs: 0 },
      ],
    };

    branches.push(newBranch);

    if (rows.length === 0) {
      await db.query(
        "INSERT INTO company_settings (id, branches) VALUES (1, ?)",
        [JSON.stringify(branches)],
      );
    } else {
      await db.query("UPDATE company_settings SET branches = ? WHERE id = 1", [
        JSON.stringify(branches),
      ]);
    }

    const { actorId, roleLabel } = getActorLabel(req);
    await insertSettingsAuditLog({
      req,
      action: "BRANCH_CREATE",
      message: `${roleLabel} (${actorId}) created branch ${branch}.`,
    });

    res.json({ success: true, message: "Branch added", data: newBranch });
  } catch (err) {
    console.error("ADD ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

router.put("/branches/:id", async (req, res) => {
  const { id } = req.params;
  const {
    branch,
    address,
    registration_open,
    start_date,
    end_date,
    start_time,
    end_time,
    academicPrograms,
  } = req.body;

  try {
    const [rows] = await db.query(
      "SELECT branches FROM company_settings WHERE id = 1",
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No settings found" });
    }

    let branches = JSON.parse(rows[0].branches || "[]");
    const existingBranch = branches.find((b) => b.id == id);

    let found = false;

    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);

      if (start > end) {
        return res.status(400).json({
          message: "Start date cannot be later than end date",
        });
      }
    }

    branches = branches.map((b) => {
      if (b.id == id) {
        found = true;

        return {
          ...b,

          branch: typeof branch !== "undefined" ? branch : b.branch,

          address: typeof address !== "undefined" ? address : b.address,

          registration_open:
            typeof registration_open !== "undefined"
              ? registration_open
              : b.registration_open,

          start_date:
            typeof start_date !== "undefined"
              ? start_date || null
              : b.start_date,

          end_date:
            typeof end_date !== "undefined" ? end_date || null : b.end_date,

          start_time:
            typeof start_time !== "undefined"
              ? start_time || null
              : b.start_time,

          end_time:
            typeof end_time !== "undefined" ? end_time || null : b.end_time,

          academicPrograms: (academicPrograms ?? b.academicPrograms ?? []).map(
            (program) => ({
              ...program,
              all_programs: Number(program.all_programs) === 1 ? 1 : 0,
            }),
          ),
        };
      }

      return b;
    });

    if (!found) {
      return res.status(404).json({ message: "Branch not found" });
    }

    await db.query("UPDATE company_settings SET branches = ? WHERE id = 1", [
      JSON.stringify(branches),
    ]);

    const updatedBranch = branches.find((b) => b.id == id);
    const branchLabel =
      updatedBranch?.branch || existingBranch?.branch || `branch ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertSettingsAuditLog({
      req,
      action: "BRANCH_UPDATE",
      message: `${roleLabel} (${actorId}) updated branch ${branchLabel}.`,
    });

    res.json({ success: true, message: "Updated successfully" });
  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

router.delete("/branches/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT branches FROM company_settings WHERE id = 1",
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No settings found" });
    }

    let branches = JSON.parse(rows[0].branches || "[]");
    const deletedBranch = branches.find((b) => b.id != null && b.id == id);

    branches = branches.filter((b) => b.id != id);

    await db.query("UPDATE company_settings SET branches = ? WHERE id = 1", [
      JSON.stringify(branches),
    ]);

    const branchLabel = deletedBranch?.branch || `branch ID ${id}`;
    const { actorId, roleLabel } = getActorLabel(req);
    await insertSettingsAuditLog({
      req,
      action: "BRANCH_DELETE",
      message: `${roleLabel} (${actorId}) deleted branch ${branchLabel}.`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

router.get("/registration-status/:branch_id", async (req, res) => {
  const { branch_id } = req.params;
  try {
    const [rows] = await db.query(
      "SELECT branches FROM company_settings WHERE id = 1",
    );
    if (rows.length === 0)
      return res.status(404).json({ message: "No settings found" });

    let branches = JSON.parse(rows[0].branches || "[]");

    // Make sure every branch has an academicPrograms array before syncing,
    // same defaulting used by GET /branches.
    branches = branches.map((b) => ({
      ...b,
      academicPrograms: (b.academicPrograms || [
        { id: 0, name: "Undergraduate", open: 1 },
        { id: 1, name: "Graduate", open: 0 },
        { id: 2, name: "Techvoc", open: 0 },
      ]).map((program) => ({
        ...program,
        all_programs: Number(program.all_programs) === 1 ? 1 : 0,
      })),
    }));

    // Branches no longer have an independent admission season. Open/closed
    // is DERIVED purely from whichever academic program(s) are currently
    // inside their own daily hour window (Undergrad / Graduate / TechVoc),
    // exactly like GET /branches does. No branch-level start_date/end_date
    // is consulted here anymore.
    const { branches: syncedBranches, changed } =
      syncBranchesOpenStatus(branches);

    if (changed) {
      await db.query("UPDATE company_settings SET branches = ? WHERE id = 1", [
        JSON.stringify(syncedBranches),
      ]);
    }

    const branch = syncedBranches.find((b) => b.id == branch_id);
    if (!branch) return res.status(404).json({ message: "Branch not found" });

    res.json({
      registration_open: Number(branch.registration_open) === 1 ? 1 : 0,
    });
  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
