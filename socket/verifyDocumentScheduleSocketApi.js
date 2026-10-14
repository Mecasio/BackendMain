const { insertAuditLogAdmission } = require("../utils/auditLogger");
const {
  formatAuditActorRole,
  createScheduleLabelHelpers,
} = require("./socketHelpers");
const { notifyScheduleUpdated } = require("./socketService");

function startVerifyDocumentScheduleSocketApi(io, { db, db3, transporter }) {
  const { getVerifyScheduleLabel } = createScheduleLabelHelpers(db);

io.on("connection", (socket) => {

    socket.on(
      "send_verify_schedule_emails",
      async ({
        schedule_id,
        applicant_numbers,
        subject,
        message,
        user_person_id,
        audit_actor_id,
        audit_actor_role,
      }) => {

        try {
          if (
            !schedule_id ||
            !Array.isArray(applicant_numbers) ||
            applicant_numbers.length === 0
          ) {
            return socket.emit("send_verify_schedule_emails_result", {
              success: false,
              error: "No applicants provided.",
            });
          }

          // OFFICE NAME
          const [[office]] = await db.query(
            "SELECT short_term FROM company_settings WHERE id = 1",
          );

          const shortTerm = office?.short_term || "EARIST";
          const officeName = `${shortTerm} - Admission Office`;

          //  Fetch applicants with email
          const [rows] = await db.query(
            `
      SELECT
        va.applicant_id,
        p.first_name,
        p.middle_name,
        p.last_name,
        p.emailAddress
      FROM verify_applicants va
      JOIN applicant_numbering_table an
        ON va.applicant_id = an.applicant_number
      JOIN person_table p
        ON an.person_id = p.person_id
      WHERE va.schedule_id = ?
      AND va.applicant_id IN (?)
      AND va.email_sent = 0
    `,
            [schedule_id, applicant_numbers],
          );

          if (rows.length === 0) {
            return socket.emit("send_verify_schedule_emails_result", {
              success: false,
              error: "No pending applicants found.",
            });
          }

          const sent = [];
          const failed = [];

          for (const row of rows) {
            if (!row.emailAddress) {
              failed.push(row.applicant_id);
              continue;
            }

            const personalizedMsg = message
              .replace("{first_name}", row.first_name || "")
              .replace("{middle_name}", row.middle_name || "")
              .replace("{last_name}", row.last_name || "")
              .replace("{applicant_number}", row.applicant_id);

            try {
              await transporter.sendMail({
                from: `"${officeName}" <${process.env.EMAIL_USER}>`,
                to: row.emailAddress,
                subject,
                text: personalizedMsg,
              });

              //  Mark sent
              await db.query(
                "UPDATE verify_applicants SET email_sent = 1 WHERE applicant_id = ?",
                [row.applicant_id],
              );

              sent.push(row.applicant_id);
            } catch (err) {
              console.error("Email failed:", err.message);

              await db.query(
                "UPDATE verify_applicants SET email_sent = -1 WHERE applicant_id = ?",
                [row.applicant_id],
              );

              failed.push(row.applicant_id);
            }
          }

          const safeActor = audit_actor_id || user_person_id || "unknown";
          const roleLabel = formatAuditActorRole(audit_actor_role);
          const scheduleLabel = await getVerifyScheduleLabel(schedule_id);
          const sentList = sent.length > 0 ? sent.join(", ") : "None";
          const failedNote =
            failed.length > 0
              ? ` Failed applicant(s): ${failed.join(", ")}.`
              : "";

          await insertAuditLogAdmission({
            actorId: safeActor,
            role: audit_actor_role || "registrar",
            action: "VERIFY_SCHEDULE_EMAIL",
            severity: sent.length > 0 ? "INFO" : "WARNING",
            message: `${roleLabel} (${safeActor}) sent document verification schedule email to ${sent.length} applicant(s) for ${scheduleLabel}. Applicant(s): ${sentList}.${failedNote}`,
          });

          //  Return result
          socket.emit("send_verify_schedule_emails_result", {
            success: true,
            sent,
            failed,
            message: `Verify emails: Sent=${sent.length}, Failed=${failed.length}`,
          });

          notifyScheduleUpdated({ schedule_id });
        } catch (err) {
          console.error("Verify email error:", err);

          socket.emit("send_verify_schedule_emails_result", {
            success: false,
            error: "Server error sending verify emails.",
          });
        }
      },
    );

    socket.on(
      "update_verify_schedule",
      async ({
        schedule_id,
        applicant_numbers,
        audit_actor_id,
        audit_actor_role,
      }) => {
        try {
          if (!schedule_id || !applicant_numbers?.length) {
            return socket.emit("update_verify_schedule_result", {
              success: false,
              error: "Schedule ID and applicants required.",
            });
          }

          //  Get quota
          const [[scheduleInfo]] = await db.query(
            `SELECT room_quota FROM verify_document_schedule WHERE schedule_id = ?`,
            [schedule_id],
          );

          if (!scheduleInfo) {
            return socket.emit("update_verify_schedule_result", {
              success: false,
              error: "Schedule not found.",
            });
          }

          const roomQuota = scheduleInfo.room_quota;

          //  Current count
          const [[{ currentCount }]] = await db.query(
            `SELECT COUNT(*) AS currentCount FROM verify_applicants WHERE schedule_id = ?`,
            [schedule_id],
          );

          let runningCount = currentCount;

          const assigned = [];
          const updated = [];
          const skipped = [];

          for (const applicant_number of applicant_numbers) {
            //  STOP when full
            if (runningCount >= roomQuota) {
              break;
            }

            const [check] = await db.query(
              `SELECT schedule_id FROM verify_applicants WHERE applicant_id = ?`,
              [applicant_number],
            );

            if (check.length > 0) {
              if (check[0].schedule_id === schedule_id) {
                skipped.push(applicant_number);
              } else {
                await db.query(
                  `UPDATE verify_applicants SET schedule_id = ? WHERE applicant_id = ?`,
                  [schedule_id, applicant_number],
                );
                updated.push(applicant_number);
                runningCount++; // increase count
              }
            } else {
              await db.query(
                `INSERT INTO verify_applicants (applicant_id, schedule_id, email_sent)
            VALUES (?, ?, 0)`,
                [applicant_number, schedule_id],
              );

              assigned.push(applicant_number);
              runningCount++; // increase count
            }
          }

          const changedApplicants = [...assigned, ...updated];
          if (changedApplicants.length > 0) {
            const safeActor = audit_actor_id || "unknown";
            const roleLabel = formatAuditActorRole(audit_actor_role);
            const scheduleLabel = await getVerifyScheduleLabel(schedule_id);

            await insertAuditLogAdmission({
              actorId: safeActor,
              role: audit_actor_role || "registrar",
              action: "VERIFY_SCHEDULE",
              severity: "INFO",
              message: `${roleLabel} (${safeActor}) assigned ${changedApplicants.length} applicant(s) to document verification ${scheduleLabel}. Applicant(s): ${changedApplicants.join(", ")}.`,
            });
          }

          socket.emit("update_verify_schedule_result", {
            success: true,
            assigned,
            updated,
            skipped,
          });
          notifyScheduleUpdated({ schedule_id });
        } catch (err) {
          console.error(" Verify assign error:", err);
          socket.emit("update_verify_schedule_result", {
            success: false,
            error: "Failed to assign applicants.",
          });
        }
      },
    );
});
}

module.exports = { startVerifyDocumentScheduleSocketApi };
