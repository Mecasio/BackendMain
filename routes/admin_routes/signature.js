const express = require("express");
const { db3 } = require("../database/database");
const multer = require("multer");
const path = require("path");
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

const insertSignatureAuditLog = async ({ req, action, verb, signatureName }) => {
  const { actorId, actorRole } = getAuditActor(req);
  const roleLabel = formatAuditActorRole(actorRole);
  const safeSignatureName = signatureName || "signature";

  await insertAuditLogAdmission({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message: `${roleLabel} (${actorId}) ${verb} signature ${safeSignatureName}.`,
  });
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../../uploads/signature"));
  },

  filename: (req, file, cb) => {
    const uniqueSuffix =
      Date.now() + "-" + Math.round(Math.random() * 1e9);

    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const uploadSignature = multer({ storage });

/*
|--------------------------------------------------------------------------
| CREATE SIGNATURE
|--------------------------------------------------------------------------
*/

router.post(
  "/signature",
  CanCreate,
  uploadSignature.single("signature"),
  async (req, res) => {
    try {
      const {
        person_id,
        employee_id,
        full_name,
        designation,
        campus_branch_id,
        signature_name,
        created_by,
      } = req.body;

      if (
        !person_id ||
        !full_name ||
        !campus_branch_id ||
        !signature_name ||
        !req.file
      ) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields",
        });
      }

      const signaturePath = `signature/${req.file.filename}`;

      const [result] = await db3.query(
        `
        INSERT INTO signature_table
        (
          person_id,
          employee_id,
          full_name,
          designation,
          campus_branch_id,
          signature_name,
          signature_image,
          created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          person_id,
          employee_id,
          full_name,
          designation,
          campus_branch_id,
          signature_name,
          signaturePath,
          created_by,
        ]
      );

      await insertSignatureAuditLog({
        req,
        action: "SIGNATURE_CREATE",
        verb: "uploaded",
        signatureName: signature_name,
      });

      res.json({
        success: true,
        data: {
          id: result.insertId,
          full_name,
          designation,
          campus_branch_id,
          signature_name,
          signature_image: signaturePath,
        },
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        success: false,
        message: "Server Error",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| GET ALL SIGNATURES
|--------------------------------------------------------------------------
*/

router.get("/signature", async (req, res) => {
  try {
    const [rows] = await db3.query(`
      SELECT *
      FROM signature_table
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
    });
  }
});

router.put("/signature/:id", CanEdit, uploadSignature.single("signature"), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      full_name,
      designation,
      campus_branch_id,
      signature_name,
      employee_id,
      person_id,
    } = req.body;

    let signaturePath = null;

    if (req.file) {
      signaturePath = `signature/${req.file.filename}`;
    }

    const query = `
      UPDATE signature_table
      SET
        full_name = ?,
        designation = ?,
        campus_branch_id = ?,
        signature_name = ?,
        employee_id = ?,
        person_id = ?
        ${signaturePath ? ", signature_image = ?" : ""}
      WHERE id = ?
    `;

    const values = signaturePath
      ? [
          full_name,
          designation,
          campus_branch_id,
          signature_name,
          employee_id,
          person_id,
          signaturePath,
          id,
        ]
      : [
          full_name,
          designation,
          campus_branch_id,
          signature_name,
          employee_id,
          person_id,
          id,
        ];

    await db3.query(query, values);

    await insertSignatureAuditLog({
      req,
      action: "SIGNATURE_UPDATE",
      verb: "updated",
      signatureName: signature_name,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/*
|--------------------------------------------------------------------------
| DELETE SIGNATURE
|--------------------------------------------------------------------------
*/

router.delete("/signature/:id", CanDelete, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db3.query(
      `
      SELECT signature_name
      FROM signature_table
      WHERE id = ?
      LIMIT 1
    `,
      [id]
    );
    const signatureName = rows?.[0]?.signature_name;

    await db3.query(
      `
      DELETE FROM signature_table
      WHERE id = ?
    `,
      [id]
    );

    await insertSignatureAuditLog({
      req,
      action: "SIGNATURE_DELETE",
      verb: "deleted",
      signatureName,
    });

    res.json({
      success: true,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
    });
  }
});

module.exports = router;
