const express = require('express');
const { db3 } = require('../database/database');
const { insertAuditLogEnrollment, resolveAuditActor } = require("../../utils/auditLogger");
const {
  CanCreate,
  CanDelete,
  CanEdit,
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

const roomLabel = (room) => {
  if (!room) return "Unknown Room";

  const building = room.building_description || "N/A";
  const description = room.room_description || "N/A";
  const floor = room.floor ? `, Floor ${room.floor}` : "";
  const type = room.type ? `, ${room.type}` : "";
  const branch = room.branch ? `, Branch ${room.branch}` : "";

  return `${building} - ${description}${floor}${type}${branch}`;
};

const insertRoomAuditLog = async ({ req, action, message }) => {
  const { actorId, actorRole } = getAuditActor(req);

  await insertAuditLogEnrollment({
    actorId,
    role: actorRole,
    action,
    severity: "INFO",
    message,
  });
};

/* ===================== GET ROOM LIST ===================== */
router.get("/room_list", async (req, res) => {
  const { branch } = req.query;

  let query = `
    SELECT 
      room_id,
      room_description,
      building_description,
      floor,
      is_airconditioned,
      type,
      branch,
      created_at,
      updated_at,
      updated_by
    FROM room_table
  `;

  const params = [];

  if (branch) {
    query += " WHERE branch = ?";
    params.push(branch);
  }

  query += " ORDER BY room_description ASC";

  try {
    const [result] = await db3.query(query, params);
    res.status(200).json(result);
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({
      error: "Query failed",
      details: err.message,
    });
  }
});


/* ===================== ADD ROOM ===================== */
router.post("/adding_room", CanCreate, async (req, res) => {
  const {
    room_description,
    building_description,
    floor,
    is_airconditioned,
    type,
    branch,
    updated_by
  } = req.body;

  try {

    if (!room_description || floor == null || type == null || branch == null) {
      return res.status(400).json({ message: "Required fields are missing" });
    }

    // Prevent duplicate room (same name + building + branch)
    const [rows] = await db3.query(
      `SELECT room_id FROM room_table
       WHERE room_description = ?
       AND building_description = ?
       AND branch = ?`,
      [room_description, building_description, branch]
    );

    if (rows.length > 0) {
      return res.status(400).json({ message: "Room already exists" });
    }

    const [insertResult] = await db3.query(
      `INSERT INTO room_table
      (room_description, building_description, floor,
       is_airconditioned, type, branch, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        room_description,
        building_description || null,
        floor,
        is_airconditioned ?? 0,
        type,
        branch,
        updated_by || null
      ]
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertRoomAuditLog({
      req,
      action: "ROOM_CREATE",
      message: `${roleLabel} (${actorId}) created room ${roomLabel({
        room_description,
        building_description,
        floor,
        type,
        branch,
      })}. Room ID: ${insertResult.insertId}.`,
    });

    res.status(200).json({ message: "✅ Room added successfully" });

  } catch (error) {
    console.error("❌ Error adding room:", error);
    res.status(500).json({ message: "Failed to add room" });
  }
});


/* ===================== UPDATE ROOM ===================== */
router.put("/update_room/:id", CanEdit, async (req, res) => {
  const { id } = req.params;

  const {
    room_description,
    building_description,
    floor,
    is_airconditioned,
    type,
    branch,
    updated_by
  } = req.body;

  try {

    const [currentRows] = await db3.query(
      "SELECT * FROM room_table WHERE room_id = ?",
      [id]
    );

    if (currentRows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const current = currentRows[0];

    // Prevent duplicate (exclude current record)
    const [exists] = await db3.query(
      `SELECT room_id FROM room_table
       WHERE room_description = ?
       AND building_description = ?
       AND branch = ?
       AND room_id != ?`,
      [
        room_description ?? current.room_description,
        building_description ?? current.building_description,
        branch ?? current.branch,
        id
      ]
    );

    if (exists.length > 0) {
      return res.status(400).json({ message: "Room already exists" });
    }

    await db3.query(
      `UPDATE room_table SET
        room_description = ?,
        building_description = ?,
        floor = ?,
        is_airconditioned = ?,
        type = ?,
        branch = ?,
        updated_by = ?
       WHERE room_id = ?`,
      [
        room_description ?? current.room_description,
        building_description ?? current.building_description,
        floor ?? current.floor,
        is_airconditioned ?? current.is_airconditioned,
        type ?? current.type,
        branch ?? current.branch,
        updated_by ?? current.updated_by,
        id
      ]
    );

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertRoomAuditLog({
      req,
      action: "ROOM_UPDATE",
      message: `${roleLabel} (${actorId}) updated room ${roomLabel(current)} to ${roomLabel({
        room_description: room_description ?? current.room_description,
        building_description: building_description ?? current.building_description,
        floor: floor ?? current.floor,
        type: type ?? current.type,
        branch: branch ?? current.branch,
      })}.`,
    });

    res.json({ message: "✅ Room updated successfully" });

  } catch (error) {
    console.error("❌ Error updating room:", error);
    res.status(500).json({ message: "Failed to update room" });
  }
});


/* ===================== DELETE ROOM ===================== */
router.delete("/delete_room/:id", CanDelete, async (req, res) => {
  const { id } = req.params;

  try {
    const [[roomBefore]] = await db3.query(
      "SELECT * FROM room_table WHERE room_id = ? LIMIT 1",
      [id]
    );

    const [result] = await db3.query(
      "DELETE FROM room_table WHERE room_id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const { actorId, actorRole } = getAuditActor(req);
    const roleLabel = formatAuditActorRole(actorRole);
    await insertRoomAuditLog({
      req,
      action: "ROOM_DELETE",
      message: `${roleLabel} (${actorId}) deleted room ${roomLabel(roomBefore)}.`,
    });

    res.json({ message: "✅ Room deleted successfully" });

  } catch (error) {
    console.error("❌ Error deleting room:", error);
    res.status(500).json({ message: "Failed to delete room" });
  }
});

module.exports = router;
