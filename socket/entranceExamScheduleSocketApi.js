const {
  insertAuditLogAdmission,
  insertAuditLogEnrollment,
} = require("../utils/auditLogger");
const { ensureAttendanceQr } = require("../utils/examAttendance");
const {
  formatAuditActorRole,
  createScheduleLabelHelpers,
} = require("./socketHelpers");
const { notifyScheduleUpdated } = require("./socketService");

function startEntranceExamScheduleSocketApi(io, { db, db3, transporter }) {
  const { getEntranceExamScheduleLabel, getInterviewScheduleLabel } =
    createScheduleLabelHelpers(db);

io.on("connection", (socket) => {
    // ENTRANCE EXAM
    socket.on(
      "update_schedule",
      async ({
        schedule_id,
        applicant_numbers,
        audit_actor_id,
        audit_actor_role,
      }) => {
        try {
          if (
            !schedule_id ||
            !applicant_numbers ||
            applicant_numbers.length === 0
          ) {
            return socket.emit("update_schedule_result", {
              success: false,
              error: "Schedule ID and applicants required.",
            });
          }

          //  Get room quota
          const [[scheduleInfo]] = await db.query(
            `SELECT room_quota FROM entrance_exam_schedule WHERE schedule_id = ?`,
            [schedule_id],
          );
          if (!scheduleInfo) {
            return socket.emit("update_schedule_result", {
              success: false,
              error: "Schedule not found.",
            });
          }
          const roomQuota = scheduleInfo.room_quota;

          //  Count how many are already assigned
          const [[{ currentCount }]] = await db.query(
            `SELECT COUNT(*) AS currentCount FROM exam_applicants WHERE schedule_id = ?`,
            [schedule_id],
          );

          // If total would exceed quota, reject
          if (currentCount + applicant_numbers.length > roomQuota) {
            return socket.emit("update_schedule_result", {
              success: false,
              error: `Room quota exceeded! Capacity: ${roomQuota}, Currently Assigned: ${currentCount}, Trying to add: ${applicant_numbers.length}.`,
            });
          }

          const assigned = [];
          const updated = [];
          const skipped = [];

          for (const applicant_number of applicant_numbers) {
            const [check] = await db.query(
              `SELECT * FROM exam_applicants WHERE applicant_id = ?`,
              [applicant_number],
            );

            if (check.length > 0) {
              if (check[0].schedule_id === schedule_id) {
                skipped.push(applicant_number); // already in this schedule
              } else {
                await db.query(
                  `UPDATE exam_applicants SET schedule_id = ?, email_sent = 0 WHERE applicant_id = ?`,
                  [schedule_id, applicant_number],
                );
                updated.push(applicant_number);
              }
            } else {
              await db.query(
                `INSERT INTO exam_applicants (applicant_id, schedule_id, email_sent) VALUES (?, ?, 0)`,
                [applicant_number, schedule_id],
              );
              assigned.push(applicant_number);
            }
          }

          const changedApplicants = [...assigned, ...updated];
          if (changedApplicants.length > 0) {
            const safeActor = audit_actor_id || "unknown";
            const roleLabel = formatAuditActorRole(audit_actor_role);
            const scheduleLabel =
              await getEntranceExamScheduleLabel(schedule_id);

            await insertAuditLogAdmission({
              actorId: safeActor,
              role: audit_actor_role || "registrar",
              action: "ENTRANCE_EXAM_SCHEDULE_ASSIGN",
              severity: "INFO",
              message: `${roleLabel} (${safeActor}) assigned ${changedApplicants.length} applicant(s) to entrance examination ${scheduleLabel}. Applicant(s): ${changedApplicants.join(", ")}.`,
            });
          }

          socket.emit("update_schedule_result", {
            success: true,
            assigned,
            updated,
            skipped,
          });
          notifyScheduleUpdated({ schedule_id });
        } catch (error) {
          console.error(" Error assigning schedule:", error);
          socket.emit("update_schedule_result", {
            success: false,
            error: "Failed to assign schedule.",
          });
        }
      },
    );

    // INTERVIEW EXAM
    socket.on(
      "update_schedule_for_interview",
      async ({
        schedule_id,
        applicant_numbers,
        audit_actor_id,
        audit_actor_role,
      }) => {
        try {
          if (
            !schedule_id ||
            !applicant_numbers ||
            applicant_numbers.length === 0
          ) {
            return socket.emit("update_schedule_result", {
              success: false,
              error: "Schedule ID and applicants required.",
            });
          }

          //  Get room quota
          const [[scheduleInfo]] = await db.query(
            `SELECT room_quota FROM interview_exam_schedule WHERE schedule_id = ?`,
            [schedule_id],
          );
          if (!scheduleInfo) {
            return socket.emit("update_schedule_result", {
              success: false,
              error: "Schedule not found.",
            });
          }
          const roomQuota = scheduleInfo.room_quota;

          //  Count how many are already assigned
          const [[{ currentCount }]] = await db.query(
            `SELECT COUNT(*) AS currentCount FROM interview_applicants WHERE schedule_id = ?`,
            [schedule_id],
          );

          // If total would exceed quota, reject
          if (currentCount + applicant_numbers.length > roomQuota) {
            return socket.emit("update_schedule_result", {
              success: false,
              error: `Room quota exceeded! Capacity: ${roomQuota}, Currently Assigned: ${currentCount}, Trying to add: ${applicant_numbers.length}.`,
            });
          }

          const assigned = [];
          const updated = [];
          const skipped = [];

          for (const applicant_number of applicant_numbers) {
            const [check] = await db.query(
              `SELECT * FROM interview_applicants WHERE applicant_id = ?`,
              [applicant_number],
            );

            if (check.length > 0) {
              if (check[0].schedule_id === schedule_id) {
                skipped.push(applicant_number); // already in this schedule
              } else {
                await db.query(
                  `UPDATE interview_applicants SET schedule_id = ?, action = 1 WHERE applicant_id = ?`,
                  [schedule_id, applicant_number],
                );
                updated.push(applicant_number);
              }
            } else {
              await db.query(
                `INSERT INTO interview_applicants (applicant_id, schedule_id, action, email_sent, status) VALUES (?, ?, 1, 0, 0)`,
                [applicant_number, schedule_id],
              );
              assigned.push(applicant_number);
            }
          }
          const changedApplicants = [...assigned, ...updated];
          if (changedApplicants.length > 0) {
            const safeActor = audit_actor_id || "unknown";
            const roleLabel = formatAuditActorRole(audit_actor_role);
            const scheduleLabel = await getInterviewScheduleLabel(schedule_id);

            await insertAuditLogEnrollment({
              actorId: safeActor,
              role: audit_actor_role || "registrar",
              action: "QUALIFYING_INTERVIEW_SCHEDULE_ASSIGN",
              severity: "INFO",
              message: `${roleLabel} (${safeActor}) assigned ${changedApplicants.length} applicant(s) to qualifying/interview ${scheduleLabel}. Applicant(s): ${changedApplicants.join(", ")}.`,
            });
          }

          socket.emit("update_schedule_result", {
            success: true,
            assigned,
            updated,
            skipped,
          });
          notifyScheduleUpdated({ schedule_id });
        } catch (error) {
          console.error(" Error assigning schedule:", error);
          socket.emit("update_schedule_result", {
            success: false,
            error: "Failed to assign schedule.",
          });
        }
      },
    );

    function formatTime(timeStr) {
      if (!timeStr) return "";
      const [hours, minutes] = timeStr.split(":"); // ignore seconds
      let h = parseInt(hours, 10);
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12; // convert 0 -> 12
      return `${h}:${minutes} ${ampm}`;
    }

    socket.on("send_schedule_emails", async (data) => {
      try {
        const {
          schedule_id,
          user_person_id,
          subject,
          message,
          audit_actor_id,
          audit_actor_role,
        } = data;

        /* ================================
           1  Get Actor Info
        ================================= */
        const [actorRows] = await db3.query(
          `SELECT email, role, employee_id, last_name, first_name, middle_name
       FROM user_accounts
       WHERE person_id = ? LIMIT 1`,
          [user_person_id],
        );

        let actorEmail = "earistmis@gmail.com";
        let actorName = "SYSTEM";

        if (actorRows.length > 0) {
          const u = actorRows[0];
          actorEmail = u.email || actorEmail;

          actorName =
            `${(u.role || "").toUpperCase()} (${u.employee_id || ""}) -
      ${u.last_name || ""}, ${u.first_name || ""} ${u.middle_name || ""}`.trim();
        }

        /* ================================
           2  Office Name
        ================================= */
        const [[office]] = await db.query(
          "SELECT short_term FROM company_settings WHERE id = 1",
        );

        const shortTerm = office?.short_term || "EARIST";
        const officeName = `${shortTerm} - Admission Office`;

        /* ================================
           3  Get Applicants
        ================================= */
        const [rows] = await db.query(
          `
        SELECT
          ea.schedule_id,

          s.day_description AS day,
          s.room_description AS room,
          s.start_time,
          s.end_time,

          an.applicant_number,

          p.person_id,
          p.first_name,
          p.last_name,
          p.emailAddress

        FROM exam_applicants ea

        JOIN entrance_exam_schedule s
          ON ea.schedule_id = s.schedule_id

        JOIN applicant_numbering_table an
          ON ea.applicant_id = an.applicant_number

        JOIN person_table p
          ON an.person_id = p.person_id

        WHERE ea.schedule_id = ?
        AND (ea.email_sent IS NULL OR ea.email_sent = 0)
        `,
          [schedule_id],
        );

        if (rows.length === 0) {
          return socket.emit("send_schedule_emails_result", {
            success: false,
            error: "No applicants found for this schedule.",
          });
        }

        /* ================================
           4  Helpers
        ================================= */
        const sent = [];
        const failed = [];
        const skipped = [];

        const formatTime = (timeStr) => {
          if (!timeStr) return "";
          const [h, m] = timeStr.split(":");
          let hour = parseInt(h);
          const ampm = hour >= 12 ? "PM" : "AM";
          hour = hour % 12 || 12;
          return `${hour}:${m} ${ampm}`;
        };

        const applyTemplate = (template, row) => {
          return template
            .replace(/{first_name}/g, row.first_name || "")
            .replace(/{last_name}/g, row.last_name || "")
            .replace(/{applicant_number}/g, row.applicant_number || "")
            .replace(/{day}/g, row.day || "")
            .replace(/{room}/g, row.room || "")
            .replace(/{start_time}/g, formatTime(row.start_time))
            .replace(/{end_time}/g, formatTime(row.end_time))
            .replace(/{office}/g, officeName);
        };

        /* ================================
           5  Send Email  (UPDATED: attaches attendance QR)
        ================================= */
        const sendEmail = async (row) => {
          if (!row.emailAddress) {
            skipped.push(row.applicant_number);
            return;
          }

          const finalMessage = applyTemplate(message, row);

          // ✅ NEW: generate (or reuse) this applicant's one-time attendance QR
          // for THIS schedule, and get the local file path to the PNG.
          let qrPath = null;
          try {
            const qrResult = await ensureAttendanceQr(
              db,
              row.schedule_id,
              row.applicant_number,
            );
            qrPath = qrResult.qrPath;
          } catch (qrErr) {
            console.error(
              `Failed to generate attendance QR for ${row.applicant_number}:`,
              qrErr,
            );
          }

          const mailOptions = {
            from: `"${officeName}" <${process.env.EMAIL_USER}>`,
            to: row.emailAddress,
            subject: subject || "Entrance Exam Schedule",
            text: qrPath
              ? `${finalMessage}\n\nYour Attendance QR Code is attached. Present this at the exam room — it can only be scanned once.`
              : finalMessage,
          };

          // ✅ NEW: attach the QR image if it was generated successfully
          if (qrPath) {
            mailOptions.attachments = [
              {
                filename: "attendance_qr.png",
                path: qrPath,
                cid: "attendanceqr",
              },
            ];
          }

          try {
            await transporter.sendMail(mailOptions);

            await db.query(
              `UPDATE exam_applicants
           SET email_sent = 1
           WHERE applicant_id = ?
           AND schedule_id = ?`,
              [row.applicant_number, row.schedule_id],
            );

            await db.query(
              `UPDATE person_status_table
           SET exam_status = 1
           WHERE person_id = ?`,
              [row.person_id],
            );

            sent.push(row.applicant_number);
          } catch (err) {
            console.error(" Email failed:", err.message);
            failed.push(row.applicant_number);
          }
        };

        /* ================================
           6  Batch Sending
        ================================= */
        const batchSize = 5;
        const delayMs = 1000;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          await Promise.all(batch.map(sendEmail));

          if (i + batchSize < rows.length) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        const safeActor =
          audit_actor_id ||
          actorRows?.[0]?.employee_id ||
          user_person_id ||
          "unknown";
        const roleLabel = formatAuditActorRole(
          audit_actor_role || actorRows?.[0]?.role,
        );
        const scheduleLabel = await getEntranceExamScheduleLabel(schedule_id);
        const sentList = sent.length > 0 ? sent.join(", ") : "None";
        const failedNote =
          failed.length > 0
            ? ` Failed applicant(s): ${failed.join(", ")}.`
            : "";
        const skippedNote =
          skipped.length > 0
            ? ` Skipped applicant(s): ${skipped.join(", ")}.`
            : "";

        await insertAuditLogAdmission({
          actorId: safeActor,
          role: audit_actor_role || actorRows?.[0]?.role || "registrar",
          action: "ENTRANCE_EXAM_SCHEDULE_EMAIL",
          severity: sent.length > 0 ? "INFO" : "WARNING",
          message: `${roleLabel} (${safeActor}) sent entrance examination schedule email to ${sent.length} applicant(s) for ${scheduleLabel}. Applicant(s): ${sentList}.${failedNote}${skippedNote}`,
        });

        /* ================================
           7  Result
        ================================= */
        socket.emit("send_schedule_emails_result", {
          success: true,
          sent,
          failed,
          skipped,
          message: `Sent=${sent.length}, Failed=${failed.length}, Skipped=${skipped.length}`,
        });

        notifyScheduleUpdated({ schedule_id });
      } catch (err) {
        console.error("send_schedule_emails ERROR:", err);

        socket.emit("send_schedule_emails_result", {
          success: false,
          error: "Server error sending emails.",
        });
      }
    });
});
}

module.exports = { startEntranceExamScheduleSocketApi };
