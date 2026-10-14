const os = require("os");

async function getMacAddress() {
  const interfaces = os.networkInterfaces();

  for (const nets of Object.values(interfaces)) {
    for (const net of nets) {
      if (
        net.family === "IPv4" &&
        !net.internal &&
        net.mac !== "00:00:00:00:00:00"
      ) {
        return net.mac;
      }
    }
  }

  return null;
}

const resolveUserMacAddress = async (req = {}) => {
  const body = req.body || {};
  const headers = req.headers || {};
  const fromClient =
    body.user_mac_address ||
    headers["x-user-mac-address"] ||
    headers["x-user-mac"];

  const normalizedClient = String(fromClient || "").trim();
  if (
    normalizedClient &&
    normalizedClient.toLowerCase() !== "null" &&
    normalizedClient !== "00:00:00:00:00:00"
  ) {
    return normalizedClient;
  }

  return getMacAddress();
};

module.exports = {
  getMacAddress,
  resolveUserMacAddress,
};
