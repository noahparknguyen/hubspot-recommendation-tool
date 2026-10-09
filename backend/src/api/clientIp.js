// backend/src/api/clientIp.js

const { config } = require("../core/config");

/**
 * Returns the address a request came from, used as the key for per-client limits.
 *
 * Behind proxies, the connection comes from the nearest proxy, and the client's
 * address is in X-Forwarded-For. Each proxy adds the address it received the
 * request from to the end of that header, and a client can put anything at the
 * start. So the entry to trust is the one the outermost proxy added:
 * `TRUST_PROXY_HOPS` entries from the end. On Render that's 3: Cloudflare and
 * two of Render's own proxies each add one. With no proxies (0, the default),
 * the header is ignored.
 *
 * @param {import("node:http").IncomingMessage} req - Incoming request
 * @param {number} [hops] - Proxies in front of the server (default: `config.http.trustProxyHops`)
 * @returns {string} Client address, or "unknown"
 */
function getClientIp(req, hops = config.http.trustProxyHops) {
  const socketIp = req.socket?.remoteAddress || "unknown";
  if (!(hops > 0)) return socketIp;

  const entries = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  // Fewer entries than proxies means the request skipped one, so nothing in
  // the header can be trusted.
  if (entries.length < hops) return socketIp;

  return entries[entries.length - hops];
}

module.exports = { getClientIp };
