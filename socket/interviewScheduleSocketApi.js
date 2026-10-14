const {
  insertAuditLogEnrollment,
} = require("../utils/auditLogger");
const {
  formatAuditActorRole,
  getSenderAccountForEmail,
  createScheduleLabelHelpers,
} = require("./socketHelpers");
const { notifyScheduleUpdated } = require("./socketService");

function startInterviewScheduleSocketApi(io, { db, db3, transporter }) {
  const { getInterviewScheduleLabel } = createScheduleLabelHelpers(db);

io.on("connection", (socket) => {

    // Assign applicants (single, 40, custom  all handled here)
    socket.on(
      "update_interview_schedule",
      async ({ schedule_id, applicant_numbers }) => {
        try {
          if (
            !Array.isArray(applicant_numbers) ||
            applicant_numbers.length === 0
          ) {
            socket.emit("update_schedule_result", {
              success: false,
              error: "No applicants provided.",
            });
            return;
          }

          //   1. Get schedule info (quota)
          const [[schedule]] = await db.query(
            `SELECT room_quota FROM interview_exam_schedule WHERE schedule_id = ?`,
            [schedule_id],
          );

          if (!schedule) {
            socket.emit("update_schedule_result", {
              success: false,
              error: "Schedule not found.",
            });
            return;
          }

          //   2. Get current occupancy
          const [[{ current_count }]] = await db.query(
            `SELECT COUNT(*) AS current_count FROM interview_applicants WHERE schedule_id = ?`,
            [schedule_id],
          );

          const availableSlots = schedule.room_quota - current_count;
          if (availableSlots <= 0) {
            socket.emit("update_schedule_result", {
              success: false,
              error: `Schedule is already full (${schedule.room_quota} applicants).`,
            });
            return;
          }

          //   3. Trim applicant_numbers if more than available slots
          const toAssign = applicant_numbers.slice(0, availableSlots);

          //  4. Update only those applicants
          const [results] = await db.query(
            `UPDATE interview_applicants
         SET schedule_id = ?, action = 1
         WHERE applicant_id IN (?)`,
            [schedule_id, toAssign],
          );

          socket.emit("update_schedule_result", {
            success: true,
            assigned: toAssign,
            updated: results.affectedRows,
            skipped: applicant_numbers.length - toAssign.length,
          });

          // Refresh schedule data for connected clients.
          notifyScheduleUpdated({ schedule_id });
        } catch (err) {
          console.error(" Error updating interview schedule:", err);
          socket.emit("update_schedule_result", {
            success: false,
            error: "Failed to update interview schedule.",
          });
        }
      },
    );

    // Unassign ALL
    socket.on("unassign_all_from_interview", async ({ schedule_id }) => {
      try {
        await db.query(
          `UPDATE interview_applicants
         SET schedule_id = NULL, action = 0
         WHERE schedule_id = ?`,
          [schedule_id],
        );
        socket.emit("unassign_all_result", {
          success: true,
          message: "All applicants unassigned.",
        });
        notifyScheduleUpdated({ schedule_id });
      } catch (err) {
        console.error(" Error unassigning all interview applicants:", err);
        socket.emit("unassign_all_result", {
          success: false,
          error: "Failed to unassign all applicants.",
        });
      }
    });

    function formatTime(timeStr) {
      if (!timeStr) return "";
      const [hours, minutes] = timeStr.split(":"); // ignore seconds
      let h = parseInt(hours, 10);
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12; // convert 0 -> 12
      return `${h}:${minutes} ${ampm}`;
    }

    //  Handle sending interview schedule emails
    //  Handle sending interview schedule emails
    socket.on(
      "send_interview_emails",
      async ({
        schedule_id,
        applicant_numbers,
        subject: finalSubject,
        senderName,
        message,
        user_person_id,
        audit_actor_id,
        audit_actor_role,
        department_id,  // ADD THIS
        program_id,     // ADD THIS
      }) => {
        try {
          const [rows] = await db.query(
            `SELECT
            ia.schedule_id,
            s.day_description,
            s.building_description,
            s.room_description,
            s.start_time,
            s.end_time,
            an.applicant_number,
            p.person_id,
            p.first_name,
            p.middle_name,
            p.last_name,
            p.emailAddress,
            dt.dprtmnt_name
          FROM interview_applicants ia
          JOIN interview_exam_schedule s 
            ON ia.schedule_id = s.schedule_id
          JOIN applicant_numbering_table an 
            ON ia.applicant_id = an.applicant_number
          JOIN person_table p 
            ON an.person_id = p.person_id
          JOIN enrollment.dprtmnt_curriculum_table dct 
            ON p.program = dct.curriculum_id
          JOIN enrollment.dprtmnt_table dt 
            ON dct.dprtmnt_id = dt.dprtmnt_id
          WHERE ia.schedule_id = ?
          AND an.applicant_number IN (?)`,
            [schedule_id, applicant_numbers],
          );

          if (rows.length === 0) {
            return socket.emit("send_schedule_emails_result", {
              success: false,
              error: "No applicants found for this interview schedule.",
            });
          }

          const [[company]] = await db.query(
            "SELECT short_term FROM company_settings WHERE id = 1",
          );

          const shortTerm = company?.short_term || "EARIST";

          const finalSubjectComputed =
            finalSubject || rows[0]?.dprtmnt_name || "Interview Schedule";

          const [actorRows] = await db3.query(
            `SELECT
            email AS actor_email,
            role,
            employee_id,
            last_name,
            first_name,
            middle_name
          FROM user_accounts
          WHERE person_id = ?
          LIMIT 1`,
            [user_person_id],
          );

          const actor = actorRows[0] || null;

          // UPDATED QUERY - filter by department_id and program_id
          // NEW — joins email_template_programs to get dprtmnt_id and program_id
          const [userEmail] = await db.query(
            `SELECT et.sender_name
   FROM email_template_employees ete
   INNER JOIN email_templates et ON ete.template_id = et.template_id
   INNER JOIN email_template_programs etp ON etp.template_id = et.template_id
   WHERE ete.employee_id = ?
     AND etp.dprtmnt_id = ?
     AND etp.program_id = ?
     AND et.is_active = 1
   ORDER BY et.updated_at DESC
   LIMIT 1`,
            [actor?.employee_id || null, department_id, program_id],
          );

          if (userEmail.length === 0) {
            throw new Error("User not assigned to a matching college email for this program.");
          }

          const senderEmail = userEmail[0].sender_name;
          const senderAccount = getSenderAccountForEmail(senderEmail);

          if (!senderAccount) {
            throw new Error(
              "Email sender account does not match a configured backend .env account.",
            );
          }

          const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: senderAccount,
          });

          const sent = [];
          const failed = [];

          function formatTime(timeStr) {
            if (!timeStr) return "";
            const [hours, minutes] = timeStr.split(":");
            let h = parseInt(hours, 10);
            const ampm = h >= 12 ? "PM" : "AM";
            h = h % 12 || 12;
            return `${h}:${minutes} ${ampm}`;
          }

          for (const row of rows) {
            if (!row.emailAddress) {
              failed.push(row.applicant_number);
              continue;
            }

            const formattedStart = formatTime(row.start_time);
            const formattedEnd = formatTime(row.end_time);

            const personalizedMsg = message
              .replace(/{first_name}/g, row.first_name || "")
              .replace(/{middle_name}/g, row.middle_name || "")
              .replace(/{last_name}/g, row.last_name || "")
              .replace(/{applicant_number}/g, row.applicant_number)
              .replace(/{day}/g, row.day_description)
              .replace(/{room}/g, row.room_description)
              .replace(/{start_time}/g, formattedStart)
              .replace(/{end_time}/g, formattedEnd);

            const mailOptions = {
              from: `${shortTerm} - ${row.dprtmnt_name} <${senderAccount.user}>`,
              to: row.emailAddress,
              subject: finalSubjectComputed,
              text: personalizedMsg,
            };

            await transporter.sendMail(mailOptions);

            try {
              await db.query(
                "UPDATE interview_applicants SET email_sent = 1 WHERE applicant_id = ?",
                [row.applicant_number],
              );
              sent.push(row.applicant_number);
            } catch (err) {
              console.error(`Failed to send interview email to ${row.emailAddress}:`, err.message);
              await db.query(
                "UPDATE interview_applicants SET email_sent = 0 WHERE applicant_id = ?",
                [row.applicant_number],
              );
              failed.push(row.applicant_number);
            }
          }

          const safeActor = audit_actor_id || actor?.employee_id || user_person_id || "unknown";
          const roleLabel = formatAuditActorRole(audit_actor_role || actor?.role);
          const scheduleLabel = await getInterviewScheduleLabel(schedule_id);
          const sentList = sent.length > 0 ? sent.join(", ") : "None";
          const failedNote = failed.length > 0 ? ` Failed applicant(s): ${failed.join(", ")}.` : "";

          await insertAuditLogEnrollment({
            actorId: safeActor,
            role: audit_actor_role || actor?.role || "registrar",
            action: "QUALIFYING_INTERVIEW_SCHEDULE_EMAIL",
            severity: sent.length > 0 ? "INFO" : "WARNING",
            message: `${roleLabel} (${safeActor}) sent qualifying/interview schedule email to ${sent.length} applicant(s) for ${scheduleLabel}. Applicant(s): ${sentList}.${failedNote}`,
          });

          socket.emit("send_schedule_emails_result", {
            success: true,
            sent,
            failed,
            message: `Interview emails processed: Sent=${sent.length}, Failed=${failed.length}`,
          });

          notifyScheduleUpdated({ schedule_id });
        } catch (err) {
          console.error("Error in send_interview_emails:", err);
          socket.emit("send_schedule_emails_result", {
            success: false,
            error: err.message || "Server error sending interview emails.",
          });
        }
      },
    );
});
}

module.exports = { startInterviewScheduleSocketApi };
