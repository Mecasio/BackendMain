const express = require("express");
const { db3 } = require("../database/database");
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  CanCreate,
  CanDelete,
} = require("../../middleware/pagePermissions");

const router = express.Router();

const formatAuditActorRole = (role) => {
  const safeRole = String(role || "registrar").trim();
  if (!safeRole) return "Registrar";

  return safeRole
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const getAuditActor = resolveAuditActor;

const insertDepartmentRoomAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    message,
    severity: "INFO",
  });
};

// DEPARTMENT ROOM PANEL
router.get("/assignments", async (req, res) => {
  const query = `
    SELECT
      drt.dprtmnt_room_id,
      drt.room_id,
      dt.dprtmnt_id,
      dt.dprtmnt_name,
      dt.dprtmnt_code,
      rt.room_description
    FROM dprtmnt_room_table drt
    INNER JOIN dprtmnt_table dt ON drt.dprtmnt_id = dt.dprtmnt_id
    INNER JOIN room_table rt ON drt.room_id = rt.room_id
  `;

  try {
    const [results] = await db3.query(query);
    res.status(200).json(results);
  } catch (err) {
    console.error("Error fetching assignments:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch assignments", details: err.message });
  }
});

// ASSIGN ROOM TO DEPARTMENT
router.post("/assign", CanCreate, async (req, res) => {
  const { dprtmnt_id, room_id } = req.body;

  if (!dprtmnt_id || !room_id) {
    return res
      .status(400)
      .json({ message: "Department and Room ID are required" });
  }

  try {
    const checkQuery = `
      SELECT * FROM dprtmnt_room_table
      WHERE dprtmnt_id = ? AND room_id = ?
    `;
    const [checkResults] = await db3.query(checkQuery, [dprtmnt_id, room_id]);

    if (checkResults.length > 0) {
      return res
        .status(400)
        .json({ message: "Room already assigned to this department" });
    }

    const insertQuery = `
      INSERT INTO dprtmnt_room_table (dprtmnt_id, room_id)
      VALUES (?, ?)
    `;
    const [insertResult] = await db3.query(insertQuery, [dprtmnt_id, room_id]);

    const [[details]] = await db3.query(
      `SELECT dt.dprtmnt_name, dt.dprtmnt_code, rt.room_description
       FROM dprtmnt_table dt
       INNER JOIN room_table rt ON rt.room_id = ?
       WHERE dt.dprtmnt_id = ?`,
      [room_id, dprtmnt_id],
    );
    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const departmentLabel = details
      ? `${details.dprtmnt_name} (${details.dprtmnt_code})`
      : `department ID ${dprtmnt_id}`;
    const roomLabel = details?.room_description || `room ID ${room_id}`;
    await insertDepartmentRoomAuditLog({
      req,
      action: "DEPARTMENT_ROOM_ASSIGN",
      message: `${roleLabel} (${actorId}) assigned room ${roomLabel} to ${departmentLabel}.`,
    });

    return res.json({
      message: "Room successfully assigned to department",
      insertId: insertResult.insertId,
    });
  } catch (err) {
    console.error("Error assigning room:", err);
    return res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
});

// UNASSIGN ROOM FROM DEPARTMENT
router.delete("/unassign/:dprtmnt_room_id", CanDelete, async (req, res) => {
  const { dprtmnt_room_id } = req.params;

  if (!dprtmnt_room_id) {
    return res.status(400).json({ message: "Assignment ID is required" });
  }

  try {
    const [[assignment]] = await db3.query(
      `SELECT dt.dprtmnt_name, dt.dprtmnt_code, rt.room_description
       FROM dprtmnt_room_table drt
       INNER JOIN dprtmnt_table dt ON drt.dprtmnt_id = dt.dprtmnt_id
       INNER JOIN room_table rt ON drt.room_id = rt.room_id
       WHERE drt.dprtmnt_room_id = ?`,
      [dprtmnt_room_id],
    );

    const deleteQuery = `
      DELETE FROM dprtmnt_room_table WHERE dprtmnt_room_id = ?
    `;
    const [result] = await db3.query(deleteQuery, [dprtmnt_room_id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Room assignment not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    const departmentLabel = assignment
      ? `${assignment.dprtmnt_name} (${assignment.dprtmnt_code})`
      : `assignment ID ${dprtmnt_room_id}`;
    const roomLabel = assignment?.room_description || "room";
    await insertDepartmentRoomAuditLog({
      req,
      action: "DEPARTMENT_ROOM_UNASSIGN",
      message: `${roleLabel} (${actorId}) unassigned room ${roomLabel} from ${departmentLabel}.`,
    });

    return res.json({ message: "Room successfully unassigned" });
  } catch (err) {
    console.error("Error unassigning room:", err);
    return res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
});

module.exports = router;
