const socketIO = require("socket.io");
const jwt = require("jsonwebtoken");

let io;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://192.168.50.211:5173",
  "http://136.239.248.62:5173",
  "http://192.168.50.64:5173",
  "http://192.168.1.9:5173",
];

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  if (allowedOrigins.indexOf(origin) !== -1) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (u.hostname.startsWith("192.168.")) return true;
  } catch (_) {}
  return false;
}

/**
 * Initialize Socket.IO server with authentication and rooms.
 * Keeps path `/api/socket.io` so existing frontend clients keep working.
 * Anonymous connections are allowed (applicant dashboard / forgot-password).
 * When a JWT is present it is verified and the socket joins user + role rooms.
 *
 * @param {http.Server} server - HTTP server instance
 * @param {string[]} [allowedOrigins]
 * @returns {import("socket.io").Server}
 */
function initializeSocket(server, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  io = socketIO(server, {
    path: "/api/socket.io",
    cors: {
      origin: function (origin, callback) {
        if (isOriginAllowed(origin, allowedOrigins)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true,
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization || "").replace(/^Bearer\s+/i, "");

    if (!token) {
      socket.userId = null;
      socket.userRole = null;
      socket.personId = null;
      socket.employeeId = null;
      return next();
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.personId = decoded.person_id || null;
      socket.employeeId = decoded.employee_id || null;
      socket.userRole = decoded.role || null;
      socket.username = decoded.email || null;
      socket.userId = String(
        decoded.employee_id || decoded.person_id || decoded.email || socket.id,
      );
      next();
    } catch (err) {
      console.warn("Socket token invalid, continuing as anonymous:", err.message);
      socket.userId = null;
      socket.userRole = null;
      socket.personId = null;
      socket.employeeId = null;
      next();
    }
  });

  io.on("connection", (socket) => {
    const label = socket.userId || "anonymous";
    console.log(`✓ User connected: ${label} [${socket.id}]`);

    if (socket.userId) {
      socket.join(socket.userId);
      console.log(`  → User ${socket.userId} joined room: ${socket.userId}`);
    }

    if (socket.personId) {
      socket.join(`person:${socket.personId}`);
    }

    if (socket.userRole) {
      socket.join(`role:${socket.userRole}`);
      console.log(
        `  → User ${label} joined role room: ${socket.userRole}`,
      );
    }

    socket.on("ping", () => {
      socket.emit("pong", {
        timestamp: new Date(),
        userId: socket.userId,
      });
    });

    socket.on("disconnect", (reason) => {
      console.log(
        `✗ User disconnected: ${label} [${socket.id}] - Reason: ${reason}`,
      );
    });

    socket.on("error", (error) => {
      console.error(`Socket error for user ${label}:`, error);
    });
  });

  console.log("Socket.IO server initialized successfully");
  return io;
}

/**
 * Get the Socket.IO server instance
 * @returns {import("socket.io").Server}
 */
function getIO() {
  if (!io) {
    throw new Error(
      "Socket.IO has not been initialized. Call initializeSocket() first.",
    );
  }
  return io;
}

module.exports = { initializeSocket, getIO };
