const getConfiguredSenderAccounts = () =>
  [
    { user: process.env.EMAIL_USER1, pass: process.env.EMAIL_PASS1 },
    { user: process.env.EMAIL_USER2, pass: process.env.EMAIL_PASS2 },
    { user: process.env.EMAIL_USER3, pass: process.env.EMAIL_PASS3 },
    { user: process.env.EMAIL_USER4, pass: process.env.EMAIL_PASS4 },
    { user: process.env.EMAIL_USER5, pass: process.env.EMAIL_PASS5 },
    { user: process.env.EMAIL_USER6, pass: process.env.EMAIL_PASS6 },
    { user: process.env.EMAIL_USER7, pass: process.env.EMAIL_PASS7 },
    { user: process.env.EMAIL_USER8, pass: process.env.EMAIL_PASS8 },
    { user: process.env.EMAIL_USER9, pass: process.env.EMAIL_PASS9 },
    { user: process.env.EMAIL_USER10, pass: process.env.EMAIL_PASS10 },
  ].filter((account) => account.user && account.pass);

const normalizeSenderEmail = (senderEmail) =>
  String(senderEmail || "")
    .trim()
    .toLowerCase();

const getSenderAccountForEmail = (senderEmail) => {
  const normalizedSenderEmail = normalizeSenderEmail(senderEmail);

  return getConfiguredSenderAccounts().find(
    (account) => normalizeSenderEmail(account.user) === normalizedSenderEmail,
  );
};

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const formatScheduleLabel = (schedule, idKey = "schedule_id") => {
  if (!schedule) return "No schedule";

  const id = schedule[idKey] || schedule.schedule_id;
  const day = schedule.day_description || schedule.schedule_date || "";
  const building = schedule.building_description || "N/A";
  const room = schedule.room_description || "";
  const start = schedule.start_time || "";
  const end = schedule.end_time || "";

  return `Schedule ${id} (${day}, ${building} ${room}, ${start}-${end})`;
};

const createScheduleLabelHelpers = (db) => {
  const getEntranceExamScheduleLabel = async (scheduleId) => {
    if (!scheduleId) return "No schedule";

    const [rows] = await db.query(
      `SELECT schedule_id, day_description, building_description, room_description, start_time, end_time
       FROM entrance_exam_schedule
       WHERE schedule_id = ?
       LIMIT 1`,
      [scheduleId],
    );

    const schedule = rows?.[0];
    if (!schedule) return `Schedule ${scheduleId}`;
    return formatScheduleLabel(schedule);
  };

  const getInterviewScheduleLabel = async (scheduleId) => {
    if (!scheduleId) return "No schedule";

    const [rows] = await db.query(
      `SELECT schedule_id, day_description, building_description, room_description, start_time, end_time
       FROM interview_exam_schedule
       WHERE schedule_id = ?
       LIMIT 1`,
      [scheduleId],
    );

    const schedule = rows?.[0];
    if (!schedule) return `Schedule ${scheduleId}`;
    return formatScheduleLabel(schedule);
  };

  const getVerifyScheduleLabel = async (scheduleId) => {
    if (!scheduleId) return "No schedule";

    const [rows] = await db.query(
      `
      SELECT schedule_id, schedule_date, building_description, room_description, start_time, end_time
      FROM verify_document_schedule
      WHERE schedule_id = ?
      LIMIT 1
      `,
      [scheduleId],
    );

    const schedule = rows?.[0];
    if (!schedule) return `Schedule ${scheduleId}`;
    return formatScheduleLabel(schedule);
  };

  return {
    getEntranceExamScheduleLabel,
    getInterviewScheduleLabel,
    getVerifyScheduleLabel,
  };
};

module.exports = {
  getConfiguredSenderAccounts,
  normalizeSenderEmail,
  getSenderAccountForEmail,
  formatAuditActorRole,
  createScheduleLabelHelpers,
};
