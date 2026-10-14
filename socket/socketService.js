const { getIO } = require("./socketServer");

/**
 * Socket Service - helper functions to emit events to users.
 * Routes call these after DB changes; frontend listens and re-fetches.
 */

function broadcastToRoles(roles, eventName, data) {
  try {
    const io = getIO();
    const timestamp = new Date().toISOString();

    roles.forEach((role) => {
      io.to(`role:${role}`).emit(eventName, { ...data, timestamp });
    });

    console.log(`✓ Broadcasted to roles [${roles.join(", ")}]: ${eventName}`);
  } catch (error) {
    console.error("Failed to broadcast to roles:", error.message);
  }
}

function notifyPageAccessGranted(employeeId, pageData) {
  try {
    const io = getIO();

    io.to(String(employeeId)).emit("pageAccessGranted", {
      action: "granted",
      page: pageData,
      timestamp: new Date().toISOString(),
      message: `Access granted to ${pageData.page_name || pageData.page_description || "page"}`,
    });

    console.log(
      `✓ Notified ${employeeId}: Access granted to page ${pageData.page_name || pageData.page_id}`,
    );
  } catch (error) {
    console.error(
      `Failed to notify page access granted for ${employeeId}:`,
      error.message,
    );
  }
}

function notifyPageAccessRevoked(employeeId, pageData) {
  try {
    const io = getIO();

    io.to(String(employeeId)).emit("pageAccessRevoked", {
      action: "revoked",
      page: pageData,
      timestamp: new Date().toISOString(),
      message: `Access revoked from ${pageData.page_name || pageData.page_description || "page"}`,
    });

    console.log(
      `✓ Notified ${employeeId}: Access revoked from page ${pageData.page_name || pageData.page_id}`,
    );
  } catch (error) {
    console.error(
      `Failed to notify page access revoked for ${employeeId}:`,
      error.message,
    );
  }
}

function notifyPageAccessChanged(employeeId, action, pageData) {
  if (action === "granted") {
    notifyPageAccessGranted(employeeId, pageData);
  } else if (action === "revoked") {
    notifyPageAccessRevoked(employeeId, pageData);
  } else {
    console.warn(`Unknown action "${action}" for page access notification`);
  }
}

function notifyMultipleUsers(userIds, eventName, data) {
  try {
    const io = getIO();

    userIds.forEach((userId) => {
      io.to(String(userId)).emit(eventName, {
        ...data,
        timestamp: new Date().toISOString(),
      });
    });

    console.log(`✓ Notified ${userIds.length} users: ${eventName}`);
  } catch (error) {
    console.error("Failed to notify multiple users:", error.message);
  }
}

function broadcastToAll(eventName, data) {
  try {
    const io = getIO();

    io.emit(eventName, {
      ...data,
      timestamp: new Date().toISOString(),
    });

    console.log(`✓ Broadcasted to all users: ${eventName}`);
  } catch (error) {
    console.error("Failed to broadcast:", error.message);
  }
}

function broadcastToRole(role, eventName, data) {
  try {
    const io = getIO();

    io.to(`role:${role}`).emit(eventName, {
      ...data,
      timestamp: new Date().toISOString(),
    });

    console.log(`✓ Broadcasted to role ${role}: ${eventName}`);
  } catch (error) {
    console.error(`Failed to broadcast to role ${role}:`, error.message);
  }
}

function notifyScheduleUpdated(data = {}) {
  broadcastToAll("schedule_updated", data);
}

function notifyAttendanceUpdated(data = {}) {
  broadcastToAll("attendance_updated", data);
}

function notifyAnnouncementChanged(action, announcement) {
  broadcastToAll("announcementChanged", { action, announcement });
  if (announcement?.target_role) {
    broadcastToRole(announcement.target_role, "announcementChanged", {
      action,
      announcement,
    });
  }
}

function broadcastNewAuditLog(logEntry) {
  try {
    const io = getIO();
    const adminRoles = [
      "superadmin",
      "administrator",
      "technical",
      "registrar",
      "admission",
    ];

    adminRoles.forEach((role) => {
      io.to(`role:${role}`).emit("auditLogCreated", logEntry);
    });

    if (logEntry.actor_id || logEntry.employeeNumber) {
      io.to(String(logEntry.actor_id || logEntry.employeeNumber)).emit(
        "auditLogCreated",
        logEntry,
      );
    }
  } catch (error) {
    console.error("Failed to broadcast audit log:", error.message);
  }
}

module.exports = {
  notifyPageAccessGranted,
  notifyPageAccessRevoked,
  notifyPageAccessChanged,
  notifyMultipleUsers,
  broadcastToAll,
  broadcastToRole,
  broadcastToRoles,
  notifyScheduleUpdated,
  notifyAttendanceUpdated,
  notifyAnnouncementChanged,
  broadcastNewAuditLog,
};
