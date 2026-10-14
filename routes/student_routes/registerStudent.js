const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const saveStudentProfilePicture = async (studentNumber, file) => {
  if (!file) return null;

  const ext = path.extname(file.originalname).toLowerCase();
  const year = new Date().getFullYear();
  const filename = `${studentNumber}_1by1_${year}${ext}`;
  const uploadDir = path.join(__dirname, "../../uploads/Student1by1");
  const finalPath = path.join(uploadDir, filename);

  await fs.promises.mkdir(uploadDir, { recursive: true });

  const files = await fs.promises.readdir(uploadDir);
  for (const existingFile of files) {
    if (existingFile.startsWith(`${studentNumber}_1by1_`)) {
      await fs.promises.unlink(path.join(uploadDir, existingFile));
    }
  }

  await fs.promises.writeFile(finalPath, file.buffer);
  return filename;
};

router.get("/students", async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT
        ua.id AS user_id,
        ua.employee_id,
        ua.profile_picture,
        pt.first_name,
        pt.middle_name,
        pt.last_name,
        ua.email,
        ua.role,
        ua.status,
        d.dprtmnt_id,
        d.dprtmnt_name,
        d.dprtmnt_code,
        snt.id AS student_numbering_id,
        snt.student_number,
        sct.curriculum_id,
        ct.program_id,
        pgt.program_description,
        pgt.program_code,
        ylt.year_level_description
      FROM user_accounts ua
      LEFT JOIN person_table pt ON ua.person_id = pt.person_id
      LEFT JOIN student_numbering_table snt ON pt.person_id = snt.person_id
      LEFT JOIN student_curriculum_table sct ON snt.id = sct.student_numbering_id
      LEFT JOIN curriculum_table ct ON sct.curriculum_id = ct.curriculum_id
      LEFT JOIN dprtmnt_curriculum_table dct ON ct.curriculum_id = dct.curriculum_id
      LEFT JOIN dprtmnt_table d ON dct.dprtmnt_id = d.dprtmnt_id
      LEFT JOIN program_table pgt ON ct.program_id = pgt.program_id
      LEFT JOIN student_status_table sst ON snt.student_number = sst.student_number
      LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
      WHERE ua.role = 'student';
    `;

    const [results] = await db3.query(sql);
    res.json(results);
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

router.post(
  "/register_student",
  upload.single("profile_picture"),
  async (req, res) => {
    const {
      student_number,
      last_name,
      middle_name,
      first_name,
      email,
      password,
      status,
      dprtmnt_id,
      curriculum_id,
    } = req.body;

    try {
      if (!student_number || !last_name || !first_name || !email || !password) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const normalizedEmail = email.toLowerCase().trim();

      const [existingEmail] = await db3.query(
        "SELECT id FROM user_accounts WHERE LOWER(email) = ?",
        [normalizedEmail],
      );
      if (existingEmail.length > 0) {
        return res
          .status(400)
          .json({ success: false, message: "Email already exists" });
      }

      const [existingStudent] = await db3.query(
        "SELECT id FROM student_numbering_table WHERE student_number = ?",
        [student_number],
      );
      if (existingStudent.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Student number already exists",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const [personInsert] = await db3.query(
        `INSERT INTO person_table (first_name, middle_name, last_name, emailAddress)
         VALUES (?, ?, ?, ?)`,
        [first_name, middle_name || null, last_name, normalizedEmail],
      );
      const personId = personInsert.insertId;
      const profilePicture = await saveStudentProfilePicture(
        student_number,
        req.file,
      );

      await db3.query(
        `INSERT INTO user_accounts
          (person_id, role, last_name, middle_name, first_name, email, password, status, dprtmnt_id, profile_picture)
         VALUES (?, 'student', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          personId,
          last_name,
          middle_name || null,
          first_name,
          normalizedEmail,
          hashedPassword,
          status || 1,
          dprtmnt_id || null,
          profilePicture,
        ],
      );

      const [studentNumInsert] = await db3.query(
        `INSERT INTO student_numbering_table (student_number, person_id)
         VALUES (?, ?)`,
        [student_number, personId],
      );

      if (curriculum_id) {
        await db3.query(
          `INSERT INTO student_curriculum_table (student_numbering_id, curriculum_id)
           VALUES (?, ?)`,
          [studentNumInsert.insertId, curriculum_id],
        );
      }

      res
        .status(201)
        .json({ success: true, message: "Student account created successfully!" });
    } catch (error) {
      console.error("Error creating student account:", error);
      res
        .status(500)
        .json({ message: "Internal Server Error", error: error.message });
    }
  },
);

router.put(
  "/update_student/:id",
  upload.single("profile_picture"),
  async (req, res) => {
    const { id } = req.params;
    const data = req.body;

    try {
      const [existing] = await db3.query(
        `
        SELECT DISTINCT
          ua.id AS user_id,
          ua.person_id,
          ua.employee_id,
          ua.profile_picture,
          ua.email,
          ua.role,
          ua.status,
          ua.dprtmnt_id,
          pt.first_name,
          pt.middle_name,
          pt.last_name,
          d.dprtmnt_name,
          d.dprtmnt_code,
          snt.id AS student_numbering_id,
          snt.student_number,
          sct.curriculum_id,
          ct.program_id,
          pgt.program_code,
          ylt.year_level_description
        FROM user_accounts ua
        LEFT JOIN person_table pt ON ua.person_id = pt.person_id
        LEFT JOIN student_numbering_table snt ON pt.person_id = snt.person_id
        LEFT JOIN student_curriculum_table sct ON snt.id = sct.student_numbering_id
        LEFT JOIN curriculum_table ct ON sct.curriculum_id = ct.curriculum_id
        LEFT JOIN dprtmnt_curriculum_table dct ON ct.curriculum_id = dct.curriculum_id
        LEFT JOIN dprtmnt_table d ON dct.dprtmnt_id = d.dprtmnt_id
        LEFT JOIN program_table pgt ON ct.program_id = pgt.program_id
        LEFT JOIN student_status_table sst ON snt.student_number = sst.student_number
        LEFT JOIN year_level_table ylt ON sst.year_level_id = ylt.year_level_id
        WHERE ua.role = 'student' AND ua.id = ?;
        `,
        [id],
      );

      if (existing.length === 0) {
        return res.json({ success: false, message: "Student not found" });
      }

      const current = existing[0];
      const nextStudentNumber = data.student_number ?? current.student_number;

      if (nextStudentNumber !== current.student_number) {
        const [duplicateStudentNumber] = await db3.query(
          "SELECT id FROM student_numbering_table WHERE student_number = ? AND person_id != ?",
          [nextStudentNumber, current.person_id],
        );

        if (duplicateStudentNumber.length > 0) {
          return res.status(400).json({
            success: false,
            message: "Student number already exists",
          });
        }
      }

      const nextEmail = (data.email ?? current.email).toLowerCase().trim();
      if (nextEmail !== current.email.toLowerCase()) {
        const [existingEmail] = await db3.query(
          "SELECT id FROM user_accounts WHERE LOWER(email) = ? AND id != ?",
          [nextEmail, id],
        );

        if (existingEmail.length > 0) {
          return res.json({ success: false, message: "Email already exists" });
        }
      }

      const profilePicture = req.file
        ? await saveStudentProfilePicture(nextStudentNumber, req.file)
        : current.profile_picture;

      const updated = {
        student_number: nextStudentNumber,
        last_name: data.last_name ?? current.last_name,
        middle_name: data.middle_name ?? current.middle_name,
        first_name: data.first_name ?? current.first_name,
        email: nextEmail,
        dprtmnt_id: data.dprtmnt_id ?? current.dprtmnt_id,
        profile_picture: profilePicture,
        status: data.status != null ? Number(data.status) : current.status,
        curriculum_id: data.curriculum_id ?? current.curriculum_id,
      };

      await db3.query(
        `UPDATE user_accounts
         SET email = ?, status = ?, dprtmnt_id = ?, profile_picture = ?
         WHERE id = ?`,
        [
          updated.email,
          updated.status,
          updated.dprtmnt_id,
          updated.profile_picture,
          id,
        ],
      );

      await db3.query(
        `UPDATE person_table
         SET first_name = ?, middle_name = ?, last_name = ?, emailAddress = ?
         WHERE person_id = ?`,
        [
          updated.first_name,
          updated.middle_name,
          updated.last_name,
          updated.email,
          current.person_id,
        ],
      );

      await db3.query(
        `UPDATE student_numbering_table
         SET student_number = ?
         WHERE person_id = ?`,
        [updated.student_number, current.person_id],
      );

      if (updated.curriculum_id) {
        const [curriculumRows] = await db3.query(
          `SELECT id FROM student_curriculum_table WHERE student_numbering_id = ?`,
          [current.student_numbering_id],
        );

        if (curriculumRows.length > 0) {
          await db3.query(
            `UPDATE student_curriculum_table
             SET curriculum_id = ?
             WHERE student_numbering_id = ?`,
            [updated.curriculum_id, current.student_numbering_id],
          );
        } else {
          await db3.query(
            `INSERT INTO student_curriculum_table (student_numbering_id, curriculum_id)
             VALUES (?, ?)`,
            [current.student_numbering_id, updated.curriculum_id],
          );
        }
      }

      res.json({ success: true, message: "Student updated successfully!" });
    } catch (error) {
      console.error("Error updating student:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

router.put("/update_student_status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const [userRows] = await db3.query(
      "SELECT id, employee_id, email, first_name, middle_name, last_name FROM user_accounts WHERE id = ? LIMIT 1",
      [id],
    );
    const [result] = await db3.query(`UPDATE user_accounts SET status = ? WHERE id = ?`, [
      status,
      id,
    ]);
    if (result.affectedRows > 0) {
      const { actorId, actorRole } = getAuditActor(req);
      const roleLabel = formatAuditActorRole(actorRole);
      const user = userRows?.[0] || {};
      const userLabel =
        user.employee_id ||
        [user.last_name, user.first_name, user.middle_name].filter(Boolean).join(", ") ||
        user.email ||
        `id ${id}`;

      await insertAuditLogEnrollment({
        actorId,
        role: actorRole,
        action: "USER_ACCOUNT_STATUS_UPDATE",
        severity: "INFO",
        message: `${roleLabel} (${actorId}) set user account ${userLabel} to ${Number(status) === 1 ? "Active" : "Inactive"}.`,
      });
    }
    res.json({ success: true, message: `Student status updated to ${status}` });
  } catch (error) {
    console.error("Error updating student status:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
