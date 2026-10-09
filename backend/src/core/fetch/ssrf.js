// backend/src/core/fetch/ssrf.js
const dnsCallback = require("node:dns");
const dns = dnsCallback.promises;
const net = require("node:net");
const { badRequest } = require("../errors");

// SSRF (Server-Side Request Forgery): attacker-supplied URLs can force the server
// to call internal network services unless host/IP resolution is restricted.
/**
 * Returns true if the IP is in a blocked range (private, localhost, link-local, etc).
 * Supports IPv4 and IPv6.
 *
 * NOTE: This is a conservative allowlist approach: if we can't parse confidently, we block.
 * In production deployments, treat this as an application-layer guardrail, not a replacement
 * for network egress policy (VPC rules, firewall, proxy allowlists, etc.).
 *
 * @param {string} ip - IP literal to classify
 * @returns {boolean} True when the IP should not be fetched by this service
 */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // unknown => block
}

function isBlockedIpv4(ip) {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true;
  }

  const [a, b, c] = parts;

  // 0.0.0.0/8 (current network) - treat as blocked
  if (a === 0) return true;

  // Blocks localhost loopback targets (common SSRF goal: local admin services).
  if (a === 127) return true;

  // Blocks RFC1918 private LAN ranges.
  if (a === 10) return true;

  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;

  // Blocks link-local metadata-like addresses in many environments.
  if (a === 169 && b === 254) return true;

  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 (protocol assignments) and the three documentation ranges:
  // never public web servers.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;

  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved, including the
  // 255.255.255.255 broadcast address)
  if (a >= 224) return true;

  return false;
}

function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();

  // IPv4-mapped IPv6 ::ffff:127.0.0.1 etc
  const mappedPrefix = "::ffff:";
  if (lower.startsWith(mappedPrefix)) {
    const tail = lower.slice(mappedPrefix.length);
    if (net.isIP(tail) === 4) return isBlockedIpv4(tail);
    // If it's malformed, block
    return true;
  }

  // The rest of ::/96 is loopback (::1), unspecified (::), or the deprecated
  // IPv4-compatible form (::127.0.0.1). No public address starts with "::".
  if (lower.startsWith("::")) return true;

  // Translation prefixes embed an IPv4 address, which may be a private one:
  // NAT64 (64:ff9b::/96, 64:ff9b:1::/48) and 6to4 (2002::/16).
  if (lower.startsWith("64:ff9b:") || lower.startsWith("2002:")) return true;

  // Discard-only (100::/64) and documentation (2001:db8::/32) ranges.
  if (lower.startsWith("100::") || lower.startsWith("2001:db8:")) return true;

  // Unique local IPv6 behaves like private LAN addressing.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  // fe00::/8: link-local (fe80::/10), the deprecated site-local (fec0::/10),
  // and the unassigned rest.
  if (lower.startsWith("fe")) return true;

  // Multicast (ff00::/8)
  if (lower.startsWith("ff")) return true;

  return false;
}

/**
 * Resolve hostname to IPs and reject if any resolved IP is blocked.
 * This is the fast first gate, run on every redirect hop (caller
 * responsibility). It can't stop DNS rebinding on its own, because the
 * connection resolves the host again: `safeLookup` closes that gap at
 * connect time. It is also the only check for IP-literal URLs, which never
 * reach a DNS lookup.
 *
 * NOTE: No SSRF protection is perfect without a network egress policy.
 * This is intended as an application-level guardrail.
 *
 * Design choice:
 * - We block if *any* A/AAAA result is non-public. This is conservative but avoids
 *   "mixed" DNS answers where a client could be routed to an internal IP.
 *
 * @param {string} hostname - Hostname or IP literal from a user-supplied URL
 * @returns {Promise<{ips: string[]}>} Resolved public IPs that passed policy checks
 * @throws {Error} AppError(400) when host is missing, internal, or DNS resolution fails
 */
async function assertPublicHost(hostname) {
  const h = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!h) throw badRequest("SSRF_BLOCKED_HOST", "Blocked host");

  // Blocks direct localhost hostnames even if DNS would resolve.
  if (h === "localhost" || h.endsWith(".localhost")) {
    throw badRequest("SSRF_BLOCKED_HOST", "Blocked host");
  }

  // Blocks internal-only naming conventions often used by private infrastructure.
  // This reduces accidental access to corp-local services through DNS search domains.
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) {
    throw badRequest("SSRF_BLOCKED_HOST", "Blocked host");
  }

  // Prevent IP-literal bypasses that skip DNS-based filtering.
  const ipFamily = net.isIP(h);
  if (ipFamily) {
    if (isBlockedIp(h)) throw badRequest("SSRF_BLOCKED_IP", "Blocked host");
    return { ips: [h] };
  }

  // Resolve all records so mixed public/private answers cannot slip through.
  let records;
  try {
    records = await dns.lookup(h, { all: true, verbatim: true });
  } catch {
    throw badRequest("SSRF_DNS_FAIL", "Could not resolve hostname");
  }

  if (!records || records.length === 0) {
    throw badRequest("SSRF_DNS_EMPTY", "Could not resolve hostname");
  }

  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw badRequest("SSRF_BLOCKED_IP", "Blocked host");
    }
  }

  return { ips: records.map((r) => r.address) };
}

/**
 * A drop-in for `dns.lookup` that refuses non-public addresses, used as the
 * connection's own lookup. The address that passes here is the address the
 * socket connects to, so DNS can't answer a separate check with a public
 * address and the connection with a private one (DNS rebinding).
 *
 * @param {string} hostname - Host the connection is about to resolve
 * @param {object} options - `dns.lookup` options passed by `net.connect`
 * @param {Function} callback - `(err, address, family)`, or `(err, addresses)` when `options.all`
 * @returns {void}
 */
function safeLookup(hostname, options, callback) {
  const opts = options && typeof options === "object" ? options : {};

  dnsCallback.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);

    if (!addresses.length || addresses.some((a) => isBlockedIp(a.address))) {
      return callback(badRequest("SSRF_BLOCKED_IP", "Blocked host"));
    }

    if (opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

module.exports = { assertPublicHost, isBlockedIp, safeLookup };
