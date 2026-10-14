const {
  insertAuditLogEnrollment,
} = require("../utils/auditLogger");

function startApplicantForgotPasswordSocketApi(io, { db, bcrypt, transporter }) {
io.on("connection", (socket) => {
    // ---------------------- Forgot Password: Applicant ----------------------
    socket.on("forgot-password-applicant", async (data) => {
      const { applicant_number, email, birthdate } = data;

      const insertForgotPasswordAuditLog = async ({ outcome }) => {
        await insertAuditLogEnrollment({
          actorId: applicant_number || email || "unknown",
          role: "applicant",
          action: "FORGOT_PASSWORD",
          outcome,
          severity: outcome === "SUCCESS" ? "INFO" : "WARN",
          message:
            outcome === "SUCCESS"
              ? "The applicant successfully reset their password through forgot password"
              : "The applicant failed to reset their password through forgot password",
        });
      };

      try {
        // =========================
        // GET SCHOOL SHORT TERM
        // =========================
        const [company] = await db.query(
          "SELECT short_term FROM company_settings WHERE id = 1",
        );

        const shortTerm = company?.[0]?.short_term || "Institution";

        // =========================
        // VALIDATE APPLICANT
        // =========================
        const [rows] = await db.query(
          `SELECT ua.email, p.birthOfDate
       FROM user_accounts ua
       JOIN person_table p ON ua.person_id = p.person_id
       JOIN applicant_numbering_table a ON p.person_id = a.person_id
       WHERE ua.email = ?
         AND a.applicant_number = ?
         AND p.birthOfDate = ?`,
          [email, applicant_number, birthdate],
        );

        // Applicant not found
        if (rows.length === 0) {
          await insertForgotPasswordAuditLog({ outcome: "FAILED" });

          return socket.emit("password-reset-result-applicant", {
            success: false,
            message: `${shortTerm} applicant account not found. Check your credentials.`,
          });
        }

        // =========================
        // GENERATE TEMP PASSWORD
        // =========================
        const generateTempPassword = () => {
          const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

          return Array.from({ length: 8 }, () =>
            chars.charAt(Math.floor(Math.random() * chars.length)),
          ).join("");
        };

        const tempPassword = generateTempPassword();

        // =========================
        // HASH PASSWORD
        // =========================
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        // =========================
        // UPDATE PASSWORD
        // =========================
        await db.query(
          "UPDATE user_accounts SET password = ? WHERE email = ?",
          [hashedPassword, email],
        );

        // =========================
        // CREATE EMAIL TRANSPORTER
        // =========================
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        // =========================
        // SEND EMAIL
        // =========================
        const info = await transporter.sendMail({
          from: `"${shortTerm} - Information System" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: `${shortTerm} Applicant Password Reset`,
          text: `
Hello Applicant,

Your ${shortTerm} applicant account password has been successfully reset.

Your new temporary password is:

${tempPassword}

Please log in immediately and change your password for security purposes.

Thank you,
${shortTerm} Information System
      `,
        });
        // =========================
        // AUDIT LOG
        // =========================
        await insertForgotPasswordAuditLog({ outcome: "SUCCESS" });

        // =========================
        // SUCCESS RESPONSE
        // =========================
        socket.emit("password-reset-result-applicant", {
          success: true,
          message: `Password has been reset successfully. The user has been notified via email.`,
        });
      } catch (error) {
        console.error("Forgot Password Applicant Error:", error);

        await insertForgotPasswordAuditLog({ outcome: "FAILED" });

        socket.emit("password-reset-result-applicant", {
          success: false,
          message: "Server error while resetting password.",
        });
      }
    });
});
}

module.exports = { startApplicantForgotPasswordSocketApi };
