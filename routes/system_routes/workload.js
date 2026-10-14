const express = require('express');
const { db3 } = require('../database/database');
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const { resolveUserMacAddress } = require("../../utils/macAddress");
const {
    validateDesignationSchedule,
} = require("../../utils/scheduleConflictValidation");
const router = express.Router();

const WORKLOAD_HOUR_LIMIT = 40;

const formatAuditActorRole = (role) => {
    const safeRole = String(role || "registrar").trim();
    if (!safeRole) return "Registrar";

    return safeRole
        .split(/[\s_-]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(" ");
};

const insertWorkloadAuditLog = async ({ req, action, message }) => {
    const { actorId, actorRole } = resolveAuditActor(req);
    const userMacAddress = await resolveUserMacAddress(req);

    await insertAuditLogEnrollment({
        actorId,
        role: actorRole,
        action,
        message,
        severity: "INFO",
        userMacAddress,
    });
};

const getActorLabel = (req) => {
    const { actorId, actorRole } = resolveAuditActor(req);
    return {
        actorId,
        roleLabel: formatAuditActorRole(actorRole),
    };
};

const formatWorkloadLabel = ({ workloadDescription, workloadCode } = {}) => {
    const description = String(workloadDescription || "").trim() || "Untitled workload";
    const code = String(workloadCode || "").trim();
    return code ? `${description} (${code})` : description;
};

function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const str = String(timeStr).trim();

    if (/AM|PM/i.test(str)) {
        const parts = str.split(" ");
        let [hours, minutes] = parts[0].split(":").map(Number);
        const modifier = parts[1].toUpperCase();

        if (modifier === "PM" && hours !== 12) hours += 12;
        if (modifier === "AM" && hours === 12) hours = 0;

        return hours * 60 + (minutes || 0);
    }

    const [hours, minutes] = str.split(":").map(Number);
    return hours * 60 + (minutes || 0);
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

function buildTimeOverlapCondition(startCol, endCol) {
    return `
    (
      (? > TIME_TO_SEC(STR_TO_DATE(${startCol}, '%l:%i %p'))/60
      AND ? < TIME_TO_SEC(STR_TO_DATE(${endCol}, '%l:%i %p'))/60)
      OR
      (? > TIME_TO_SEC(STR_TO_DATE(${startCol}, '%l:%i %p'))/60
      AND ? < TIME_TO_SEC(STR_TO_DATE(${endCol}, '%l:%i %p'))/60)
      OR
      (TIME_TO_SEC(STR_TO_DATE(${startCol}, '%l:%i %p'))/60 > ?
      AND TIME_TO_SEC(STR_TO_DATE(${startCol}, '%l:%i %p'))/60 < ?)
      OR
      (TIME_TO_SEC(STR_TO_DATE(${endCol}, '%l:%i %p'))/60 > ?
      AND TIME_TO_SEC(STR_TO_DATE(${endCol}, '%l:%i %p'))/60 < ?)
      OR
      (TIME_TO_SEC(STR_TO_DATE(${startCol}, '%l:%i %p'))/60 = ?
      AND TIME_TO_SEC(STR_TO_DATE(${endCol}, '%l:%i %p'))/60 = ?)
    )`;
}

async function getProfessorDisplayName(profId) {
    const [rows] = await db3.query(
        `SELECT lname, fname, mname FROM prof_table WHERE prof_id = ? LIMIT 1`,
        [profId]
    );

    if (!rows.length) {
        return "the selected professor";
    }

    const prof = rows[0];
    return `${prof.lname || ""}, ${prof.fname || ""} ${prof.mname || ""}`.trim();
}

function buildTimeConflictMessage(professorName) {
    return `Conflict Detected!\nProfessor ${professorName} is already assigned to this schedule. Please choose a different time.`;
}

function minutesToHours(minutes) {
    return Math.round((minutes / 60) * 10) / 10;
}

function sumScheduleMinutes(rows) {
    return rows.reduce((sum, row) => {
        const start = timeToMinutes(row.school_time_start);
        const end = timeToMinutes(row.school_time_end);
        return sum + Math.max(0, end - start);
    }, 0);
}

async function getProfessorScheduleMinutes(
    profId,
    schoolYearId,
    excludeScheduleId = null
) {
    let query = `
      SELECT school_time_start, school_time_end
      FROM time_table
      WHERE professor_id = ? AND school_year_id = ?
    `;
    const params = [profId, schoolYearId];

    if (excludeScheduleId) {
        query += " AND id != ?";
        params.push(excludeScheduleId);
    }

    const [rows] = await db3.query(query, params);
    return sumScheduleMinutes(rows);
}

async function getSchoolYearLabel(schoolYearId) {
    const [rows] = await db3.query(
        `SELECT yt.year_description, st.semester_description
         FROM active_school_year_table AS asy
         LEFT JOIN year_table AS yt ON asy.year_id = yt.year_id
         LEFT JOIN semester_table AS st ON asy.semester_id = st.semester_id
         WHERE asy.id = ?
         LIMIT 1`,
        [schoolYearId]
    );

    if (!rows.length) {
        return "the active school year";
    }

    const row = rows[0];
    return `${row.year_description} - ${row.semester_description}`;
}

async function checkDesignationConflicts({
    day,
    start_time,
    end_time,
    school_year_id,
    prof_id,
    subject_id,
    exclude_schedule_id = null,
}) {
    const startMinutes = timeToMinutes(start_time);
    const endMinutes = timeToMinutes(end_time);
    const earliest = timeToMinutes("7:00 AM");
    const latest = timeToMinutes("9:00 PM");

    if (endMinutes <= startMinutes) {
        return {
            conflict: true,
            status: 409,
            message: "End time must be later than start time (same day only).",
        };
    }

    if (startMinutes < earliest || endMinutes > latest) {
        return {
            conflict: true,
            status: 409,
            message: "Time must be between 7:00 AM and 9:00 PM (same day).",
        };
    }

    const overlapParams = getOverlapBindParams(startMinutes, endMinutes);

    let timeTableConflictQuery = `
      SELECT id FROM time_table
      WHERE room_day = ?
        AND school_year_id = ?
        AND professor_id = ?
        AND ${buildTimeOverlapCondition("school_time_start", "school_time_end")}
    `;
    const timeTableConflictParams = [day, school_year_id, prof_id, ...overlapParams];
    if (exclude_schedule_id) {
        timeTableConflictQuery += " AND id != ?";
        timeTableConflictParams.push(exclude_schedule_id);
    }

    const [timeTableConflicts] = await db3.query(
        timeTableConflictQuery,
        timeTableConflictParams
    );
    if (timeTableConflicts.length > 0) {
        const professorName = await getProfessorDisplayName(prof_id);
        return {
            conflict: true,
            status: 409,
            message: buildTimeConflictMessage(professorName),
        };
    }

    const facultyWorkloadConflictQuery = `
      SELECT fw.id FROM faculty_workload fw
      INNER JOIN prof_table pt ON pt.employee_id = fw.employee_id
      WHERE fw.day = ?
        AND fw.school_year_id = ?
        AND pt.prof_id = ?
        AND ${buildTimeOverlapCondition("fw.start", "fw.end")}
    `;
    const [facultyWorkloadConflicts] = await db3.query(
        facultyWorkloadConflictQuery,
        [day, school_year_id, prof_id, ...overlapParams]
    );
    if (facultyWorkloadConflicts.length > 0) {
        const professorName = await getProfessorDisplayName(prof_id);
        return {
            conflict: true,
            status: 409,
            message: buildTimeConflictMessage(professorName),
        };
    }

    return {
        conflict: false,
        status: 200,
        message: "Schedule is available.",
    };
}

router.get('/workload', async (req, res) => {
    try {
        const getQuery = 'SELECT * FROM workload_type';

        const [result] = await db3.query(getQuery);

        if (result.length === 0) {
            return res.status(404).send({ message: "Eisting Records not found" });
        }

        res.json(result);
    } catch (err) {
        console.log("Debug Error", err);
        res.status(500).json({ message: "Server Error" });
    }
});

router.post('/workload', async (req, res) => {
    const { workloadDescription, workloadCode, workloadColor } = req.body;

    try {
        if (!workloadDescription) {
            return res.status(401).send({ message: "Missing Requirements or Credentials" });
        }

        const insertQuery = `INSERT INTO workload_type(workload_description, workload_code, workload_color) VALUES (?, ?, ?)`;

        await db3.query(insertQuery, [workloadDescription, workloadCode, workloadColor || null]);

        const { actorId, roleLabel } = getActorLabel(req);
        await insertWorkloadAuditLog({
            req,
            action: "WORKLOAD_TYPE_CREATE",
            message: `${roleLabel} (${actorId}) created workload type ${formatWorkloadLabel({
                workloadDescription,
                workloadCode,
            })}.`,
        });

        res.json({ message: "Successfully created new workload type" });
    } catch (err) {
        console.log("Debug Error", err);
        res.status(500).json({ message: "Server Error" });
    }
});

router.put('/workload/:id', async (req, res) => {
    const { workloadDescription, workloadCode, workloadColor } = req.body;
    const { id } = req.params;

    try {
        if (!id || !workloadDescription) {
            return res.status(401).send({ message: "Missing Requirements or Credentials" });
        }

        const updateQuery = 'UPDATE workload_type SET workload_description = ?, workload_code = ?, workload_color = ? WHERE id = ?';
        await db3.query(updateQuery, [workloadDescription, workloadCode, workloadColor || null, id]);

        const { actorId, roleLabel } = getActorLabel(req);
        await insertWorkloadAuditLog({
            req,
            action: "WORKLOAD_TYPE_UPDATE",
            message: `${roleLabel} (${actorId}) updated workload type ${formatWorkloadLabel({
                workloadDescription,
                workloadCode,
            })}.`,
        });

        res.status(200).send({ message: "Successfully update the workload" });
    } catch (err) {
        console.log("Debug Error", err);
        res.status(500).json({ message: "Server Error" });
    }
});

router.delete('/workload/:id', async (req, res) => {
    const { id } = req.params;

    try {
        if (!id) {
            return res.status(401).send({ message: "Missing Requirements or Credentials" });
        }

        const [[existing]] = await db3.query(
            "SELECT workload_description, workload_code FROM workload_type WHERE id = ? LIMIT 1",
            [id],
        );

        const updateQuery = 'DELETE FROM workload_type WHERE id = ?';
        await db3.query(updateQuery, [id]);

        const { actorId, roleLabel } = getActorLabel(req);
        await insertWorkloadAuditLog({
            req,
            action: "WORKLOAD_TYPE_DELETE",
            message: `${roleLabel} (${actorId}) deleted workload type ${formatWorkloadLabel({
                workloadDescription: existing?.workload_description,
                workloadCode: existing?.workload_code,
            })}.`,
        });

        res.status(200).send({ message: "Successfully deleted the workload" });
    } catch (err) {
        console.log("Debug Error", err);
        res.status(500).json({ message: "Server Error" });
    }
})

// GET WORKLOADS TYPE FOR DESIGNATION SCHEDULE PLOTTER
router.get("/designation_list", async (req, res) => {
    const query = "SELECT id AS course_id, workload_description AS course_description, workload_code AS course_code FROM workload_type";

    try {
        const [result] = await db3.query(query);
        res.status(200).json(result);
    } catch (err) {
        console.error("Query error:", err);
        res.status(500).json({
            error: "Query failed",
            details: err.message,
        });
    }
});

// CHECK CONFLICT FOR DESIGNATION (time_table + faculty_workload)
router.post("/check-conflict-designation", async (req, res) => {
    const {
        day,
        start_time,
        end_time,
        school_year_id,
        prof_id,
        subject_id,
        exclude_schedule_id,
    } = req.body;

    if (!day || !start_time || !end_time || !school_year_id || !prof_id || !subject_id) {
        return res.status(400).json({
            conflict: true,
            message: "Missing required fields",
        });
    }

    try {
        const result = await validateDesignationSchedule(db3, {
            day,
            start_time,
            end_time,
            school_year_id,
            prof_id,
            subject_id,
            exclude_schedule_id,
        });

        return res.status(result.status).json({
            conflict: result.conflict,
            message: result.message,
        });
    } catch (error) {
        console.error("Database query error:", error);
        return res.status(500).json({
            conflict: true,
            message: "Internal server error",
        });
    }
});

router.post("/check-designation", async (req, res) => {
    const {
        day_of_week,
        school_year_id,
        employee_id,
        subject_id,
        start_time,
        end_time,
    } = req.body;

    if (!school_year_id || !subject_id || !day_of_week) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const result = await validateDesignationSchedule(db3, {
            day: day_of_week,
            start_time: start_time || "7:00 AM",
            end_time: end_time || "7:30 AM",
            school_year_id,
            prof_id: employee_id,
            subject_id,
        });

        return res.json({ exists: result.conflict });
    } catch (error) {
        console.error("Database query error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/check-designation-time", async (req, res) => {
    const { start_time, end_time } = req.body;

    try {
        let startMinutes = timeToMinutes(start_time);
        let endMinutes = timeToMinutes(end_time);
        const earliest = timeToMinutes("7:00 AM");
        const latest = timeToMinutes("9:00 PM");

        console.log({
            start_time,
            end_time,
            startMinutes,
            endMinutes,
            earliest,
            latest,
        });

        if (endMinutes <= startMinutes) {
            return res.status(409).json({
                conflict: true,
                message: "End time must be later than start time (same day only).",
            });
        }

        //  Check validity
        if (startMinutes < earliest || endMinutes > latest) {
            return res.status(409).json({
                conflict: true,
                message: "Time must be between 7:00 AM and 9:00 PM (same day).",
            });
        }

        return res.status(200).json({
            conflict: false,
            message: "Valid schedule time",
        });
    } catch (err) {
        console.error("Error checking conflict:", err);
        return res
            .status(500)
            .json({ error: "Server error while checking conflict" });
    }
});

router.post("/check-if-conflict", async (req, res) => {
    const {
        day,
        start_time,
        end_time,
        school_year_id,
        employee_id,
        subject_id,
    } = req.body;

    try {
        const start_time_m = timeToMinutes(start_time);
        const end_time_m = timeToMinutes(end_time);

        const countQuery = `
            SELECT COUNT(*) AS subject_count
            FROM time_table
            WHERE department_section_id = ?
                AND school_year_id = ?
                AND professor_id = ?
                AND department_room_id = ?
                AND course_id = ?
            `;

        const [countResult] = await db3.query(countQuery, [
            section_id,
            school_year_id,
            prof_id,
            room_id,
            subject_id,
        ]);

        if (countResult[0].subject_count >= 2) {
            return res.status(409).json({
                conflict: true,
                message:
                    "This subject is already assigned twice for the same section, room, school year, and professor.",
            });
        }

        const query = `
            SELECT * FROM time_table
            WHERE department_section_id = ?
                AND school_year_id = ?
                AND course_id = ?
                AND room_day = ?
        `;

        const [subjectResult] = await db3.query(query, [
            section_id,
            school_year_id,
            subject_id,
            day,
        ]);

        if (subjectResult.length > 0) {
            return res.status(409).json({
                conflict: true,
                message:
                    "This subject is already assigned in this section and school year on the same day.",
            });
        }

        // Check for time conflicts (prof, section, room)
        const checkTimeQuery = `
      SELECT * FROM time_table
      WHERE room_day = ?
        AND school_year_id = ?
        AND (professor_id = ? OR department_section_id = ? OR department_room_id = ?)
        AND (
          (? > TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60
          AND ? < TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60)
          OR
          (? > TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60
          AND ? < TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60)
          OR
          (TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60 > ?
          AND TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60 < ?)
          OR
          (TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60 > ?
          AND TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60 < ?)
          OR
          (TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60 = ?
          AND TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60 = ?)
        )
    `;

        const [timeResult] = await db3.query(checkTimeQuery, [
            day,
            school_year_id,
            prof_id,
            section_id,
            room_id,
            start_time_m,
            start_time_m,
            end_time_m,
            end_time_m,
            start_time_m,
            end_time_m,
            start_time_m,
            end_time_m,
            start_time_m,
            end_time_m,
        ]);

        if (timeResult.length > 0) {
            return res.status(409).json({
                conflict: true,
                message:
                    "Schedule conflict detected! Please choose a different time.",
            });
        }

        return res
            .status(200)
            .json({ conflict: false, message: "Schedule is available." });
    } catch (error) {
        console.error("Database query error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

//INSERT SCHEDULE
router.post("/insert-designation", async (req, res) => {
    const { day, start_time, end_time, subject_id, prof_id, school_year_id } =
        req.body;

    if (!day || !start_time || !end_time || !school_year_id || !prof_id) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    let startMinutes = timeToMinutes(start_time);
    let endMinutes = timeToMinutes(end_time);
    const earliest = timeToMinutes("7:00 AM");
    const latest = timeToMinutes("9:00 PM");

    // Validate times
    if (endMinutes <= startMinutes) {
        return res.status(409).json({
            conflict: true,
            message: "End time must be later than start time (same day only).",
        });
    }

    if (startMinutes < earliest || endMinutes > latest) {
        return res.status(409).json({
            conflict: true,
            message: "Time must be between 7:00 AM and 9:00 PM (same day).",
        });
    }

    try {
        // Check for time conflicts (prof, section, room)
        const checkTimeQuery = `
      SELECT * FROM time_table
      WHERE room_day = ?
        AND school_year_id = ?
        AND (professor_id = ? OR department_section_id = ?)
        AND (
          (? > TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60
          AND ? < TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60)
          OR
          (? > TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60
          AND ? < TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60)
          OR
          (TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60 > ?
          AND TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60 < ?)
          OR
          (TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60 > ?
          AND TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60 < ?)
          OR
          (TIME_TO_SEC(STR_TO_DATE(school_time_start, '%l:%i %p'))/60 = ?
          AND TIME_TO_SEC(STR_TO_DATE(school_time_end, '%l:%i %p'))/60 = ?)
        )
    `;

        const [timeResult] = await db3.query(checkTimeQuery, [
            day,
            school_year_id,
            prof_id,
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
            startMinutes,
            endMinutes,
            startMinutes,
            endMinutes,
        ]);

        if (timeResult.length > 0) {
            return res.status(409).json({
                conflict: true,
                message:
                    "Schedule conflict detected! Please choose a different time.",
            });
        }

        // Insert schedule
        const insertQuery = `
      INSERT INTO time_table
      (room_day, school_time_start, school_time_end, department_section_id, course_id, professor_id, department_room_id, school_year_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
        await db3.query(insertQuery, [
            day,
            start_time,
            end_time,
            null,
            subject_id,
            prof_id,
            null,
            school_year_id,
        ]);

        res.status(200).json({ message: "Schedule inserted successfully" });
    } catch (error) {
        console.error("Error inserting schedule:", error);
        res.status(500).json({ error: "Failed to insert schedule" });
    }
});

router.post("/check-professor-workload-hours", async (req, res) => {
    const {
        prof_id,
        school_year_id,
        start_time,
        end_time,
        exclude_schedule_id = null,
    } = req.body;

    if (!prof_id || !school_year_id || !start_time || !end_time) {
        return res.status(400).json({
            exceeds_limit: false,
            message: "Missing required fields",
        });
    }

    try {
        const addingMinutes = Math.max(
            0,
            timeToMinutes(end_time) - timeToMinutes(start_time)
        );
        const currentMinutes = await getProfessorScheduleMinutes(
            prof_id,
            school_year_id,
            exclude_schedule_id
        );
        const projectedMinutes = currentMinutes + addingMinutes;
        const professorName = await getProfessorDisplayName(prof_id);
        const schoolYearLabel = await getSchoolYearLabel(school_year_id);

        const currentHours = minutesToHours(currentMinutes);
        const addingHours = minutesToHours(addingMinutes);
        const projectedHours = minutesToHours(projectedMinutes);
        const exceedsLimit = projectedHours > WORKLOAD_HOUR_LIMIT;

        return res.status(200).json({
            exceeds_limit: exceedsLimit,
            professor_name: professorName,
            current_hours: currentHours,
            adding_hours: addingHours,
            projected_hours: projectedHours,
            limit_hours: WORKLOAD_HOUR_LIMIT,
            school_year_label: schoolYearLabel,
        });
    } catch (error) {
        console.error("Error checking professor workload hours:", error);
        return res.status(500).json({
            exceeds_limit: false,
            message: "Failed to check professor workload hours",
        });
    }
});

module.exports = router;
