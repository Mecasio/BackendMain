const express = require('express');
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { db } = require('../database/database');
const router = express.Router();

// Ito
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024 // ✅ 4MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/jpg",
      "application/pdf"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPG, JPEG, PNG, PDF allowed"));
    }

    cb(null, true);
  }
});

router.post("/upload", upload.single("file"), async (req, res) => {
  const { requirements_id, person_id, remarks } = req.body;

  if (!requirements_id || !person_id || !req.file) {
    return res.status(400).json({ error: "Missing required fields or file" });
  }

  try {
    //  Applicant info
    const [[appInfo]] = await db.query(
      `
      SELECT ant.applicant_number, pt.last_name, pt.first_name, pt.middle_name
      FROM applicant_numbering_table ant
      JOIN person_table pt ON ant.person_id = pt.person_id
      WHERE ant.person_id = ?
    `,
      [person_id],
    );

    const applicant_number = appInfo?.applicant_number || "Unknown";
    const fullName = `${appInfo?.last_name || ""}, ${appInfo?.first_name || ""} ${appInfo?.middle_name?.charAt(0) || ""}.`;

    //  Requirement description + short label
    const [descRows] = await db.query(
      "SELECT description, short_label FROM requirements_table WHERE id = ?",
      [requirements_id],
    );

    if (!descRows.length)
      return res.status(404).json({ message: "Requirement not found" });

    const { short_label } = descRows[0];

    //  Use the short_label directly from DB
    const shortLabel = short_label || "Unknown";

    const year = new Date().getFullYear();
    const ext = path.extname(req.file.originalname).toLowerCase();

    //  Construct filename
    const filename = `${applicant_number}_${shortLabel}_${year}${ext}`;
    const uploadDir = path.join(
      __dirname,
      "..",
      "..",
      "uploads",
      "ApplicantOnlineDocuments"
    );

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

    const finalPath = path.join(uploadDir, filename);

    //  Delete any existing file for the same applicant + requirement
    const [existingFiles] = await db.query(
      `SELECT upload_id, file_path FROM requirement_uploads
       WHERE person_id = ? AND requirements_id = ?`,
      [person_id, requirements_id],
    );

    for (const file of existingFiles) {
      const oldPath = path.join(
        __dirname,
        "..",
        "..",
        "uploads",
        "ApplicantOnlineDocuments",
        file.file_path,
      );

      try {
        await fs.promises.unlink(oldPath);
      } catch (err) {
        if (err.code !== "ENOENT")
          console.warn("File delete warning:", err.message);
      }

      await db.query("DELETE FROM requirement_uploads WHERE upload_id = ?", [
        file.upload_id,
      ]);
    }

    //  Save new file
    await fs.promises.writeFile(finalPath, req.file.buffer);

    await db.query(
      `INSERT INTO requirement_uploads
        (requirements_id, person_id, file_path, original_name, status, remarks)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [
        requirements_id,
        person_id,
        filename,
        req.file.originalname,
        remarks || null,
      ],
    );

    res.status(201).json({ message: " Upload successful" });
  } catch (err) {
    console.error("Upload error:", err);
    res
      .status(500)
      .json({ error: "Failed to save upload", details: err.message });
  }
});

router.get("/requirements/preview/:filename", async (req, res) => {
  const { filename } = req.params;

  try {
    const sources = [
      {
        dbConnection: db,
        folderName: "ApplicantOnlineDocuments",
      },
      {
        dbConnection: db3,
        folderName: "StudentOnlineDocuments",
      },
    ];

    let foundFile = null;
    let foundFolder = null;

    for (const source of sources) {
      const [rows] = await source.dbConnection.query(
        `SELECT upload_id, person_id, file_path, original_name
         FROM requirement_uploads
         WHERE file_path = ?`,
        [filename]
      );

      if (rows.length) {
        foundFile = rows[0];
        foundFolder = source.folderName;
        break;
      }
    }

    if (!foundFile) {
      return res.status(404).json({ message: "File not found" });
    }

    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "uploads",
      foundFolder,
      foundFile.file_path
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File missing on server" });
    }

    res.setHeader(
      "Content-Disposition",
      `inline; filename="${foundFile.original_name || foundFile.file_path}"`
    );

    return res.sendFile(filePath);
  } catch (err) {
    console.error("Preview error:", err);
    return res.status(500).json({ message: "Preview failed" });
  }
});

router.delete("/uploads/:id", async (req, res) => {
  const person_id = req.headers["x-person-id"];
  const { id } = req.params;

  if (!person_id) {
    return res.status(401).json({ message: "Unauthorized: Missing person ID" });
  }

  try {
    const [results] = await db.query(
      "SELECT file_path FROM requirement_uploads WHERE upload_id = ? AND person_id = ?",
      [id, person_id],
    );

    if (!results.length) {
      return res.status(403).json({ error: "Unauthorized or file not found" });
    }

    const filePath = results[0].file_path;

    const fullPath = path.join(
      __dirname,
      "..",
      "..",
      "uploads",
      "ApplicantOnlineDocuments",
      filePath
    );

    try {
      await fs.promises.unlink(fullPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("File delete error:", err);
      }
    }

    await db.query(
      "DELETE FROM requirement_uploads WHERE upload_id = ?",
      [id]
    );

    // ✅ Reset requirements status back to 0 so the modal can re-trigger
    await db.query(
      "UPDATE person_status_table SET requirements = 0 WHERE person_id = ?",
      [person_id]
    );

    res.json({ message: "Requirement deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete requirement" });
  }
});

// POST /submit-requirements
router.post("/submit-requirements", async (req, res) => {
  const { person_id } = req.body;

  if (!person_id) {
    return res.status(400).json({ error: "Missing person_id" });
  }

  try {
    const [result] = await db.query(
      "UPDATE person_status_table SET requirements = 1 WHERE person_id = ?",
      [person_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Applicant status record not found" });
    }

    res.json({ message: "Requirements submitted successfully" });
  } catch (err) {
    console.error("Submit requirements error:", err);
    res.status(500).json({ error: "Failed to update requirements status" });
  }
});

router.get("/applicant-status/:person_id", async (req, res) => {
  const { person_id } = req.params;
  try {
    const [[row]] = await db.query(
      "SELECT requirements FROM person_status_table WHERE person_id = ?",
      [person_id]
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ requirements: row.requirements });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      error: "File exceeds 4MB limit"
    });
  }

  if (err.message === "Only JPG, JPEG, PNG, PDF allowed") {
    return res.status(400).json({
      error: err.message
    });
  }

  next(err);
});

module.exports = router;
