const express = require("express");
const router = express.Router();
const { db, db3 } = require("../database/database");

const isNstpRelatedCourse = (subject) => {
  const code = String(subject?.course_code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const description = String(subject?.course_description || "").toUpperCase();

  return (
    /^NSTP/.test(code) ||
    /^NST/.test(code) ||
    code.includes("CWTS") ||
    code.includes("CTWS") ||
    code.includes("LTS") ||
    code.includes("MTS") ||
    description.includes("NATIONAL SERVICE TRAINING") ||
    description.includes("CIVIC WELFARE TRAINING") ||
    description.includes("LITERACY TRAINING SERVICE") ||
    description.includes("RESERVE OFFICERS TRAINING")
  );
};

router.get("/student-assessment/:person_id", async (req, res) => {
  const { person_id } = req.params;
  const enrolledStatus = req.query.enrolled_status;

  try {
    console.log("Person ID: ", person_id);

    const [studentRows] = await db3.query(
      `
            SELECT DISTINCT
                p.person_id,
                sn.student_number,
                p.first_name,
                p.middle_name,
                p.last_name
            FROM student_numbering_table sn
            LEFT JOIN person_table p ON sn.person_id = p.person_id
            WHERE sn.person_id = ?
        `,
      [person_id],
    );

    const student = studentRows?.[0];

    if (!student) {
      return res
        .status(404)
        .json({ success: false, error: "Student not found" });
    }

    const statusParams = [student.student_number];
    let enrolledStatusClause = "";

    if (enrolledStatus !== undefined && enrolledStatus !== "") {
      enrolledStatusClause = " AND ss.enrolled_status = ?";
      statusParams.push(Number(enrolledStatus));
    }

    const [statusRows] = await db3.query(
      `
            SELECT DISTINCT 
                ss.*,
                yt.year_description,
                sem.semester_id,
                sem.semester_description,
                yl.year_level_description
            FROM student_status_table ss
            LEFT JOIN year_level_table yl ON ss.year_level_id = yl.year_level_id
            LEFT JOIN active_school_year_table sy ON ss.active_school_year_id = sy.id
            LEFT JOIN semester_table sem ON sy.semester_id = sem.semester_id
            LEFT JOIN year_table yt ON sy.year_id = yt.year_id
            WHERE ss.student_number = ?
            ${enrolledStatusClause}
            ORDER BY ss.id ASC
        `,
      statusParams,
    );

    if (!statusRows || statusRows.length === 0) {
      return res.json({
        success: true,
        student,
        rows: [],
        officially_enrolled: false,
        message:
          Number(enrolledStatus) === 1
            ? "Student is not officially enrolled."
            : "Student status not found",
      });
    }

    // ✅ Deduplicate by active_school_year_id — keep first occurrence
    const uniqueStatusRows = Object.values(
      statusRows.reduce((acc, row) => {
        const key = row.active_school_year_id;
        if (!acc[key]) acc[key] = row;
        return acc;
      }, {}),
    );

    const [tosfRows] = await db3.query(`SELECT * FROM tosf LIMIT 1`);
    const tosf = tosfRows[0] || {};

    const rows = await Promise.all(
      uniqueStatusRows.map(async (s) => {
        const semesterId = s.semester_id || 1;

        const [unifastRows] = await db3.query(
          `SELECT id, total_tosf, scholarship_id, remark, active_school_year_id
                     FROM unifast
                     WHERE student_number = ?
                       AND active_school_year_id = ?
                       AND status = 1
                     ORDER BY id DESC
                     LIMIT 1`,
          [student.student_number, s.active_school_year_id],
        );

        const [matriculationRows] = await db3.query(
          `SELECT DISTINCT
                        m.id,
                        m.total_tosf,
                        m.payment,
                        COALESCE(m.balance, 0) AS balance_status,
                        m.scholarship_id,
                        m.matriculation_remark,
                        m.remark,
                        COALESCE(mpl.balance, 0) AS balance,
                        st.scholarship_name
                     FROM matriculation m
                     LEFT JOIN matriculation_payment_lines mpl
                       ON mpl.matriculation_id = m.id
                     LEFT JOIN scholarship_type st ON st.id = m.scholarship_id
                     WHERE m.student_number = ?
                       AND m.active_school_year_id = ?
                       AND m.status = 1
                     ORDER BY m.id DESC
                     LIMIT 1`,
          [student.student_number, s.active_school_year_id],
        );

        const unifastPayment = unifastRows[0] || null;
        const matriculationPayment = unifastPayment
          ? null
          : matriculationRows[0] || null;
        const legacyBalance = Number(matriculationPayment?.balance_status || 0);
        const resolvedBalance = Number.isFinite(
          Number(matriculationPayment?.balance),
        )
          ? Number(matriculationPayment.balance)
          : 0;
        const paymentBalance =
          resolvedBalance > 0
            ? resolvedBalance
            : legacyBalance > 1
              ? legacyBalance
              : 0;

        const [transactionRows] = await db3.query(
          `SELECT COALESCE(SUM(tt.payment), 0) AS total_payment
                     FROM transaction_table tt
                     WHERE tt.student_number = ?
                       AND tt.active_school_year_id = ?
                       AND COALESCE(tt.payment_status, 'PAID') <> 'VOID'
                       AND COALESCE(tt.receipt_status, 'PAID_NOT_PRINTED') <> 'VOID'`,
          [student.student_number, s.active_school_year_id],
        );
        const totalPaidAmount = Number(
          transactionRows?.[0]?.total_payment || 0,
        );

        const [subjects] = await db3.query(
          `
                    SELECT DISTINCT
                        c.course_id,
                        c.course_code,
                        c.course_description,
                        c.course_unit,
                        pt.lec_fee,
                        pt.lab_fee,
                        pt.is_nstp,
                        pt.iscomputer_lab,
                        pt.islaboratory_fee
                    FROM program_tagging_table pt
                    INNER JOIN course_table c ON pt.course_id = c.course_id
                    WHERE pt.curriculum_id = ?
                      AND pt.year_level_id = ?
                      AND pt.semester_id = ?
                      AND c.course_id IS NOT NULL
                      AND TRIM(COALESCE(c.course_code, '')) <> ''
                    ORDER BY c.course_code ASC
                `,
          [s.active_curriculum, s.year_level_id, semesterId],
        );

        let tuitionFee = 0;
        subjects.forEach((subject) => {
          tuitionFee += Number(subject.lec_fee || 0);
          tuitionFee += Number(subject.lab_fee || 0);
        });

        const hasNSTP = subjects.some(
          (subject) =>
            Number(subject.is_nstp) === 1 || isNstpRelatedCourse(subject),
        );
        const nstpFee = hasNSTP ? Number(tosf.nstp_fees || 0) : 0;

        const hasComputerLab = subjects.some(
          (s) => Number(s.iscomputer_lab) === 1,
        );
        const computerFee = hasComputerLab
          ? Number(tosf.computer_fees || 0)
          : 0;

        const isFirstYearFirstSem =
          Number(s.year_level_id) === 1 && Number(semesterId) === 1;
        const schoolIdFee = isFirstYearFirstSem
          ? Number(tosf.school_id_fees || 0)
          : 0;

        const miscellaneousFee =
          Number(tosf.athletic_fee || 0) +
          Number(tosf.cultural_fee || 0) +
          Number(tosf.developmental_fee || 0) +
          Number(tosf.guidance_fee || 0) +
          Number(tosf.library_fee || 0) +
          Number(tosf.medical_and_dental_fee || 0) +
          Number(tosf.registration_fee || 0) +
          schoolIdFee +
          computerFee;

        const miscellaneousBreakdown = [
          { label: "Athletic Fee", amount: Number(tosf.athletic_fee || 0) },
          { label: "Cultural Fee", amount: Number(tosf.cultural_fee || 0) },
          {
            label: "Developmental Fee",
            amount: Number(tosf.developmental_fee || 0),
          },
          { label: "Guidance Fee", amount: Number(tosf.guidance_fee || 0) },
          { label: "Library Fee", amount: Number(tosf.library_fee || 0) },
          {
            label: "Medical & Dental Fee",
            amount: Number(tosf.medical_and_dental_fee || 0),
          },
          {
            label: "Registration Fee",
            amount: Number(tosf.registration_fee || 0),
          },
          { label: "School ID Fee", amount: schoolIdFee },
          { label: "Computer Fee", amount: computerFee },
        ].filter((fee) => Number(fee.amount) > 0);

        const totalTuition = tuitionFee + nstpFee;
        const grandTotal = totalTuition + miscellaneousFee;
        const storedAssessment = Number(
          matriculationPayment?.total_tosf ??
          unifastPayment?.total_tosf ??
          grandTotal,
        );
        const storedPayment = unifastPayment
          ? storedAssessment
          : totalPaidAmount;
        const discountAmount = Math.max(grandTotal - storedAssessment, 0);

        // ✅ Fixed: fall back to assessment - actual payments when there's no
        // matriculation record to source a balance from
        const storedBalance = unifastPayment
          ? 0
          : matriculationPayment
            ? paymentBalance
            : Math.max(storedAssessment - totalPaidAmount, 0);

        const paymentType = unifastPayment
          ? "UNIFAST"
          : matriculationPayment
            ? "Matriculation"
            : "";

        console.log("Tuition Fee:", tuitionFee);
        console.log("NSTP Fee:", nstpFee);
        console.log("Computer Fee:", computerFee);
        console.log("School ID Fee:", schoolIdFee);
        console.log("Misc Fee:", miscellaneousFee);
        console.log("Grand Total:", grandTotal);

        return {
          active_school_year_id: s.active_school_year_id,
          enrolled_status: Number(s.enrolled_status || 0),
          curriculum_id: s.active_curriculum,
          year_level_id: s.year_level_id,
          semester_id: semesterId,
          school_year: s.year_description || "",
          semester: s.semester_description || "First Semester",
          year_level: s.year_level_description || "",
          payment_type: paymentType,
          payment_status: unifastPayment
            ? "Fully Paid"
            : storedBalance > 0
              ? "With Balance"
              : matriculationPayment
                ? "Fully Paid"
                : "No Payment Record",
          scholarship: unifastPayment
            ? "UNIFAST"
            : matriculationPayment?.scholarship_name ||
            matriculationPayment?.matriculation_remark ||
            "",
          payment: storedPayment,
          payment_total: totalPaidAmount,
          balance: storedBalance,
          assessment: storedAssessment,
          subjects,
          fees: {
            tuitionFee,
            nstpFee,
            computerFee,
            schoolIdFee,
            miscellaneousFee,
            miscellaneousBreakdown,
            totalTuition,
            originalGrandTotal: grandTotal,
            discountAmount,
            grandTotal: storedAssessment,
          },
        };
      }),
    );

    return res.json({
      success: true,
      student,
      rows,
    });
  } catch (error) {
    console.error("ASSESSMENT ERROR:", error);
    return res
      .status(500)
      .json({ success: false, error: "Failed to fetch assessment" });
  }
});

module.exports = router;
