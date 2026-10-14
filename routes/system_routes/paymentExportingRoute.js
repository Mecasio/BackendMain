const express = require("express");
const nodemailer = require("nodemailer");
const { db, db3 } = require("../database/database");
const { getMatriculationFeeLines } = require("../../utils/matriculationFeeLines");
const { getMatriculationPaymentLine } = require("../../utils/matriculationPaymentLines");
const { getUnifastFeeLines } = require("../../utils/unifastFeeLines");
const { getUnifastPaymentLine } = require("../../utils/unifastPaymentLines");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");

const router = express.Router();
const tempPasswords = new Map();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const generateTempPassword = () => {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pick = (chars) => chars[Math.floor(Math.random() * chars.length)];
  let result = "";
  for (let i = 0; i < 8; i += 1) {
    result += pick(upper);
  }
  return result;
};

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ================= FOR APPLICANT =================
router.get("/get_applicant_data", async (req, res) => {
  try {
    const [rows] = await db3.query(`
        SELECT 
            ea.applicant_id, 
            pt.campus AS campus_id,
            pt.first_name, 
            pt.last_name, 
            pt.middle_name, 
            ct.curriculum_id,
            pgt.program_id, 
            pgt.program_description, 
            pgt.program_code, 
            sy.semester_id,
            sy.year_id,
            ees.building_description,
            ees.room_description,
            ees.start_time,
            ees.end_time,
            ees.proctor
        FROM admission.exam_applicants ea
        INNER JOIN admission.entrance_exam_schedule ees ON ea.schedule_id = ees.schedule_id
        INNER JOIN enrollment.active_school_year_table sy ON ees.active_school_year_id = sy.id
        INNER JOIN admission.applicant_numbering_table ant ON ea.applicant_id = ant.applicant_number
        INNER JOIN admission.person_table pt ON ant.person_id = pt.person_id
        INNER JOIN enrollment.curriculum_table ct ON pt.program = ct.curriculum_id
        INNER JOIN enrollment.program_table pgt ON ct.program_id = pgt.program_id
        WHERE ea.email_sent = 1;
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching data" });
  }
});

// =================== FOR STUDENT =============== //

// FOR UNIFAST
router.get("/get_student_data_unifast", async (req, res) => {
  try {
    const [rows] = await db3.query(`
        SELECT u.*, st.*, pgt.*, ct.curriculum_id, sy.year_id, pt.campus AS campus_id FROM student_status_table sst
            INNER JOIN unifast u ON sst.student_number = u.student_number
            INNER JOIN active_school_year_table sy ON u.active_school_year_id = sy.id
            INNER JOIN semester_table st ON sy.semester_id = st.semester_id
            INNER JOIN curriculum_table ct ON sst.active_curriculum = ct.curriculum_id
            INNER JOIN program_table pgt ON ct.program_id = pgt.program_id
            INNER JOIN student_numbering_table snt ON sst.student_number = snt.student_number
            INNER JOIN person_table pt ON snt.person_id = pt.person_id
        WHERE sst.enrolled_status = 1 GROUP BY u.student_number, u.active_school_year_id;
    `);

    const rowsWithPaymentData = await Promise.all(
      rows.map(async (row) => {
        const paymentLine = await getUnifastPaymentLine(db3, row.id);
        const feeLines = await getUnifastFeeLines(db3, row.id);

        return {
          ...row,
          tuition_fees: paymentLine?.tuition_fees ?? row.tuition_fees ?? 0,
          total_tosf: paymentLine?.total_tosf ?? row.total_tosf ?? 0,
          payment: paymentLine?.payment ?? row.payment ?? 0,
          balance: paymentLine?.balance ?? row.balance ?? 0,
          fee_lines: Array.isArray(feeLines) ? feeLines : [],
        };
      }),
    );

    res.json(rowsWithPaymentData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching data" });
  }
});

// FOR MATRICULATION
router.get("/get_student_data_matriculation", async (req, res) => {
  try {
    const [rows] = await db3.query(`
        SELECT m.*, st.*, pgt.*, ct.curriculum_id, sy.year_id, pt.campus AS campus_id FROM student_status_table sst
            INNER JOIN matriculation m ON sst.student_number = m.student_number
            INNER JOIN active_school_year_table sy ON m.active_school_year_id = sy.id
            INNER JOIN semester_table st ON sy.semester_id = st.semester_id
            INNER JOIN curriculum_table ct ON sst.active_curriculum = ct.curriculum_id
            INNER JOIN program_table pgt ON ct.program_id = pgt.program_id
            INNER JOIN student_numbering_table snt ON sst.student_number = snt.student_number
            INNER JOIN person_table pt ON snt.person_id = pt.person_id
        WHERE sst.enrolled_status = 1 GROUP BY m.student_number, m.active_school_year_id;
    `);

    const rowsWithPaymentData = await Promise.all(
      rows.map(async (row) => {
        const paymentLine = await getMatriculationPaymentLine(db3, row.id);
        const feeLines = await getMatriculationFeeLines(db3, row.id);
        const computedBalance =
          paymentLine?.balance ??
          Math.max(Number(row.total_tosf || 0) - Number(row.payment || 0), 0);

        return {
          ...row,
          tuition_fees: paymentLine?.tuition_fees ?? row.tuition_fees ?? 0,
          total_tosf: paymentLine?.total_tosf ?? row.total_tosf ?? 0,
          payment: paymentLine?.payment ?? row.payment ?? 0,
          balance: computedBalance,
          balance_status: Number(row.balance ?? 0),
          tuition_is_paid:
            paymentLine?.tuition_is_paid ?? row.tuition_is_paid ?? 0,
          tuition_paid_amount:
            paymentLine?.tuition_paid_amount ?? row.tuition_paid_amount ?? 0,
          fee_lines: Array.isArray(feeLines) ? feeLines : [],
        };
      }),
    );

    res.json(rowsWithPaymentData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while fetching data" });
  }
});

router.delete("/delete_unifast/:student_number/:id", async (req, res) => {
  const { student_number, id } = req.params;
  const { generatedId } = req.body;

  try {
    await db3.query("DELETE FROM unifast WHERE student_number = ? AND id = ?", [
      student_number,
      id,
    ]);
    await db3.query(
      "UPDATE matriculation SET unifast_id = ?, remark = 'Transferred FROM Unifast' WHERE student_number = ?",
      [generatedId, student_number],
    );
    res.json({ message: "Unifast record deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while deleting record" });
  }
});

router.delete("/delete_matriculation/:student_number/:id", async (req, res) => {
  const { student_number, id } = req.params;
  const { generatedId } = req.body;
  try {
    await db3.query(
      "DELETE FROM matriculation WHERE student_number = ? AND id = ?",
      [student_number, id],
    );

    await db3.query(
      "UPDATE unifast SET matriculation_id = ?, remark = 'Transferred FROM Matriculation' WHERE student_number = ?",
      [generatedId, student_number],
    );
    res.json({ message: "Matriculation record deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while deleting record" });
  }
});

router.post("/send-temp-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res
      .status(400)
      .json({ message: "student_number and email are required" });
  }

  try {
    const tempPassword = generateTempPassword();
    tempPasswords.set(String(email), {
      code: tempPassword,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Temporary Password for Transfer",
      text: `To continue please enter your temporary password: ${tempPassword}`,
    });

    res.json({ success: true, message: "Temporary password sent" });
    console.log(tempPassword);
  } catch (error) {
    console.error("Error sending temp password:", error);
    res.status(500).json({ message: "Failed to send temporary password" });
  }
});

router.post("/verify-temp-password", async (req, res) => {
  const { email, tempPassword } = req.body;

  if (!email || !tempPassword) {
    return res
      .status(400)
      .json({ message: "email and tempPassword are required" });
  }

  const entry = tempPasswords.get(String(email));

  if (!entry) {
    return res.status(400).json({ message: "No temporary password found" });
  }

  if (Date.now() > entry.expiresAt) {
    tempPasswords.delete(String(email));
    return res.status(400).json({ message: "Temporary password expired" });
  }

  if (entry.code !== tempPassword) {
    return res.status(400).json({ message: "Invalid temporary password" });
  }

  tempPasswords.delete(String(email));


  res.json({ success: true });
});

router.post("/payment-export/audit", async (req, res) => {
  const { exported_count, payment_type, person_type } = req.body;

  try {
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const paymentLabel = Number(payment_type) === 1 ? "matriculation" : "UNIFAST";
    const personLabel = Number(person_type) === 1 ? "applicant" : "student";

    await insertAuditLogEnrollment({
      actorId,
      role: actorRole,
      action: "PAYMENT_EXPORT",
      severity: "INFO",
      message: `${roleLabel} (${actorId}) exported ${Number(exported_count) || 0} ${personLabel} ${paymentLabel} payment record(s).`,
    });

    res.json({ success: true, message: "Payment export audit log inserted" });
  } catch (error) {
    console.error("Payment export audit error:", error);
    res.status(500).json({ message: "Failed to insert payment export audit log" });
  }
});



module.exports = router;
