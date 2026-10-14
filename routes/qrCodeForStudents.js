const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { db, db3 } = require('./database/database');

const router = express.Router();

const studentQrDirectory = path.join(
  __dirname,
  '..',
  'uploads',
  'StudentQRCodeGenerated',
);

const ensureStudentQrCode = async (studentNumber) => {
  const qrFilename = `${studentNumber}_qrcode.png`;
  const qrPath = path.join(studentQrDirectory, qrFilename);
  const alreadyExists = fs.existsSync(qrPath);

  await fs.promises.mkdir(studentQrDirectory, { recursive: true });

  if (!alreadyExists) {
    let frontendUrl = String(process.env.FRONTEND_URL || '').trim();
    if (frontendUrl && !/^https?:\/\//i.test(frontendUrl)) {
      frontendUrl = `http://${frontendUrl}`;
    }
    if (!frontendUrl) {
      throw new Error('FRONTEND_URL is not configured');
    }

    await QRCode.toFile(
      qrPath,
      `${frontendUrl}/student_qr_information/${encodeURIComponent(studentNumber)}`,
      { color: { dark: '#000', light: '#FFF' }, width: 300 },
    );
  }

  return {
    generated: !alreadyExists,
    qr_code_url: `/uploads/StudentQRCodeGenerated/${encodeURIComponent(qrFilename)}`,
  };
};

router.post('/students/:studentNumber/ensure-qr', async (req, res) => {
  const studentNumber = String(req.params.studentNumber || '').trim();
  if (!studentNumber || !/^[A-Za-z0-9_-]+$/.test(studentNumber)) {
    return res.status(400).json({ success: false, message: 'Student number is required.' });
  }

  try {
    const [students] = await db3.query(
      'SELECT student_number FROM student_numbering_table WHERE student_number = ? LIMIT 1',
      [studentNumber],
    );
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const qr = await ensureStudentQrCode(studentNumber);
    return res.json({ success: true, ...qr });
  } catch (err) {
    console.error(`Failed to ensure QR code for ${studentNumber}:`, err);
    return res.status(500).json({ success: false, message: 'Unable to generate student QR code.' });
  }
});

router.get("/student_qr_information/:student_number", async (req, res) => {
  const { student_number } = req.params;
  try {
    const [rows] = await db3.query(
      `
        SELECT 
          snt.student_number,
          p.last_name,
          p.first_name,
          p.middle_name,
          p.extension,
          prog.program_description AS program,
          ylt.year_level_id,
          ylt.year_level_description,
          dpt.dprtmnt_name AS department_name,
          dpt.dprtmnt_code AS department_code,
          CASE 
            WHEN sts.enrolled_status = 1 AND sy.astatus = 1 THEN 1 
            ELSE 0 
          END AS enrolled
        FROM student_numbering_table snt
        LEFT JOIN person_table p ON snt.person_id = p.person_id
        LEFT JOIN student_status_table sts ON sts.student_number = snt.student_number
        LEFT JOIN active_school_year_table sy ON sts.active_school_year_id = sy.id
        LEFT JOIN year_level_table ylt ON sts.year_level_id = ylt.year_level_id
        LEFT JOIN curriculum_table c ON sts.active_curriculum = c.curriculum_id
        LEFT JOIN program_table prog ON c.program_id = prog.program_id
        LEFT JOIN dprtmnt_curriculum_table dct ON c.curriculum_id = dct.curriculum_id
        LEFT JOIN dprtmnt_table dpt ON dct.dprtmnt_id = dpt.dprtmnt_id
        WHERE snt.student_number = ?
        ORDER BY sts.active_school_year_id DESC
        LIMIT 1;
      `,
      [student_number],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "student not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Failed to get student QR information:", err);
    res.status(500).send("Failed to get student QR information.");
  }
});
module.exports = router;
