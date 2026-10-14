function timeToMinutes(timeValue) {
  if (!timeValue) return Number.NaN;

  const value = String(timeValue).trim();
  const match = value.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return Number.NaN;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const modifier = match[3]?.toUpperCase();

  if (minutes > 59 || (modifier && (hours < 1 || hours > 12))) {
    return Number.NaN;
  }
  if (!modifier && hours > 23) return Number.NaN;

  if (modifier === "PM" && hours !== 12) hours += 12;
  if (modifier === "AM" && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

function getOverlapBindParams(startMinutes, endMinutes) {
  return [
    startMinutes,
    startMinutes,
    endMinutes,
    endMinutes,
    startMinutes,
    endMinutes,
    startMinutes,
    endMinutes,
    startMinutes,
    endMinutes,
  ];
}

function buildTimeOverlapCondition(startColumn, endColumn) {
  return `(
    (? > TIME_TO_SEC(STR_TO_DATE(${startColumn}, '%l:%i %p')) / 60
      AND ? < TIME_TO_SEC(STR_TO_DATE(${endColumn}, '%l:%i %p')) / 60)
    OR (? > TIME_TO_SEC(STR_TO_DATE(${startColumn}, '%l:%i %p')) / 60
      AND ? < TIME_TO_SEC(STR_TO_DATE(${endColumn}, '%l:%i %p')) / 60)
    OR (TIME_TO_SEC(STR_TO_DATE(${startColumn}, '%l:%i %p')) / 60 > ?
      AND TIME_TO_SEC(STR_TO_DATE(${startColumn}, '%l:%i %p')) / 60 < ?)
    OR (TIME_TO_SEC(STR_TO_DATE(${endColumn}, '%l:%i %p')) / 60 > ?
      AND TIME_TO_SEC(STR_TO_DATE(${endColumn}, '%l:%i %p')) / 60 < ?)
    OR (TIME_TO_SEC(STR_TO_DATE(${startColumn}, '%l:%i %p')) / 60 = ?
      AND TIME_TO_SEC(STR_TO_DATE(${endColumn}, '%l:%i %p')) / 60 = ?)
  )`;
}

function validateRequiredFields(fields) {
  const missing = Object.entries(fields)
    .filter(([, value]) => value === undefined || value === null || value === "")
    .map(([name]) => name);

  if (!missing.length) return null;
  return {
    conflict: true,
    status: 400,
    code: "MISSING_REQUIRED_FIELDS",
    message: `Missing required fields: ${missing.join(", ")}.`,
  };
}

function validateTimeRange(startTime, endTime) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
    return {
      conflict: true,
      status: 400,
      code: "INVALID_TIME_FORMAT",
      message: "Start time and end time must be valid times.",
    };
  }
  if (endMinutes <= startMinutes) {
    return {
      conflict: true,
      status: 409,
      code: "INVALID_TIME_RANGE",
      message: "End time must be later than start time (same day only).",
    };
  }

  const earliest = timeToMinutes("7:00 AM");
  const latest = timeToMinutes("9:00 PM");
  if (startMinutes < earliest || endMinutes > latest) {
    return {
      conflict: true,
      status: 409,
      code: "TIME_OUTSIDE_ALLOWED_HOURS",
      message: "Time must be between 7:00 AM and 9:00 PM (same day).",
    };
  }

  return { startMinutes, endMinutes };
}

async function validateRegularSchedule(executor, schedule) {
  const requiredError = validateRequiredFields({
    day: schedule.day,
    start_time: schedule.start_time,
    end_time: schedule.end_time,
    section_id: schedule.section_id,
    subject_id: schedule.subject_id,
    prof_id: schedule.prof_id,
    room_id: schedule.room_id,
    school_year_id: schedule.school_year_id,
  });
  if (requiredError) return requiredError;

  const timeRange = validateTimeRange(schedule.start_time, schedule.end_time);
  if (timeRange.conflict) return timeRange;

  const [[assignmentCount]] = await executor.query(
    `SELECT COUNT(*) AS subject_count
     FROM time_table
     WHERE department_section_id = ?
       AND school_year_id = ?
       AND professor_id = ?
       AND department_room_id = ?
       AND course_id = ?`,
    [
      schedule.section_id,
      schedule.school_year_id,
      schedule.prof_id,
      schedule.room_id,
      schedule.subject_id,
    ],
  );
  if (Number(assignmentCount?.subject_count) >= 2) {
    return {
      conflict: true,
      status: 409,
      code: "SUBJECT_ASSIGNMENT_LIMIT",
      message:
        "This subject is already assigned twice for the same section, room, school year, and professor.",
    };
  }

  const [sameDaySubject] = await executor.query(
    `SELECT id FROM time_table
     WHERE department_section_id = ?
       AND school_year_id = ?
       AND course_id = ?
       AND room_day = ?
     LIMIT 1`,
    [schedule.section_id, schedule.school_year_id, schedule.subject_id, schedule.day],
  );
  if (sameDaySubject.length) {
    return {
      conflict: true,
      status: 409,
      code: "DUPLICATE_SUBJECT_DAY",
      message:
        "This subject is already assigned in this section and school year on the same day.",
    };
  }

  const [overlaps] = await executor.query(
    `SELECT id FROM time_table
     WHERE room_day = ?
       AND school_year_id = ?
       AND (professor_id = ? OR department_section_id = ? OR department_room_id = ?)
       AND ${buildTimeOverlapCondition("school_time_start", "school_time_end")}
     LIMIT 1`,
    [
      schedule.day,
      schedule.school_year_id,
      schedule.prof_id,
      schedule.section_id,
      schedule.room_id,
      ...getOverlapBindParams(timeRange.startMinutes, timeRange.endMinutes),
    ],
  );
  if (overlaps.length) {
    return {
      conflict: true,
      status: 409,
      code: "SCHEDULE_TIME_CONFLICT",
      message: "Schedule conflict detected! Please choose a different time.",
    };
  }

  const [workloadOverlaps] = await executor.query(
    `SELECT fw.id FROM faculty_workload fw
     INNER JOIN prof_table pt ON pt.employee_id = fw.employee_id
     WHERE fw.day = ?
       AND fw.school_year_id = ?
       AND pt.prof_id = ?
       AND ${buildTimeOverlapCondition("fw.start", "fw.end")}
     LIMIT 1`,
    [
      schedule.day,
      schedule.school_year_id,
      schedule.prof_id,
      ...getOverlapBindParams(timeRange.startMinutes, timeRange.endMinutes),
    ],
  );
  if (workloadOverlaps.length) {
    return {
      conflict: true,
      status: 409,
      code: "SCHEDULE_TIME_CONFLICT",
      message: "Schedule conflict detected! Please choose a different time.",
    };
  }

  return { conflict: false, status: 200, message: "Schedule is available." };
}

async function getProfessorDisplayName(executor, professorId) {
  const [rows] = await executor.query(
    "SELECT lname, fname, mname FROM prof_table WHERE prof_id = ? LIMIT 1",
    [professorId],
  );
  if (!rows.length) return "the selected professor";

  const professor = rows[0];
  return `${professor.lname || ""}, ${professor.fname || ""} ${professor.mname || ""}`.trim();
}

async function validateDesignationSchedule(executor, schedule) {
  const requiredError = validateRequiredFields({
    day: schedule.day,
    start_time: schedule.start_time,
    end_time: schedule.end_time,
    subject_id: schedule.subject_id,
    prof_id: schedule.prof_id,
    school_year_id: schedule.school_year_id,
  });
  if (requiredError) return requiredError;

  const timeRange = validateTimeRange(schedule.start_time, schedule.end_time);
  if (timeRange.conflict) return timeRange;

  const exclusionSql = schedule.exclude_schedule_id ? " AND id != ?" : "";
  const exclusionParams = schedule.exclude_schedule_id
    ? [schedule.exclude_schedule_id]
    : [];

  const overlapParams = getOverlapBindParams(
    timeRange.startMinutes,
    timeRange.endMinutes,
  );
  const [scheduleOverlaps] = await executor.query(
    `SELECT id FROM time_table
     WHERE room_day = ?
       AND school_year_id = ?
       AND professor_id = ?
       AND ${buildTimeOverlapCondition("school_time_start", "school_time_end")}${exclusionSql}
     LIMIT 1`,
    [
      schedule.day,
      schedule.school_year_id,
      schedule.prof_id,
      ...overlapParams,
      ...exclusionParams,
    ],
  );

  const [workloadOverlaps] = await executor.query(
    `SELECT fw.id FROM faculty_workload fw
     INNER JOIN prof_table pt ON pt.employee_id = fw.employee_id
     WHERE fw.day = ?
       AND fw.school_year_id = ?
       AND pt.prof_id = ?
       AND ${buildTimeOverlapCondition("fw.start", "fw.end")}
     LIMIT 1`,
    [schedule.day, schedule.school_year_id, schedule.prof_id, ...overlapParams],
  );

  if (scheduleOverlaps.length || workloadOverlaps.length) {
    const professorName = await getProfessorDisplayName(executor, schedule.prof_id);
    return {
      conflict: true,
      status: 409,
      code: "PROFESSOR_TIME_CONFLICT",
      message: `Conflict Detected!\nProfessor ${professorName} is already assigned to this schedule. Please choose a different time.`,
    };
  }

  return { conflict: false, status: 200, message: "Schedule is available." };
}

module.exports = {
  validateDesignationSchedule,
  validateRegularSchedule,
};
