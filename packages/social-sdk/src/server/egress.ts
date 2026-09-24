/**
 * Static egress checks for URLs that come from untrusted identity documents and
 * server metadata. They only look at the URL itself: the scheme, `localhost`
 * names, and IP-literal hosts. A hostname that resolves through DNS to a private
 * address is not caught here, because `fetch` gives no portable way to see or pin
 * the resolved address across Node.js, Bun, and edge runtimes. Server callers
 * that need that guarantee inject a `fetch` that pins DNS results.
 */

/** IPv4 ranges that are never valid public destinations (RFC 6890 and successors). */
const BLOCKED_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 carrier-grade NAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 documentation
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 documentation
  [0xcb007100, 24], // 203.0.113.0/24 documentation
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved and broadcast
];

const V4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseV4(host: string): number | undefined {
  const match = V4_PATTERN.exec(host);

  if (match === null) return undefined;
  let value = 0;

  for (const part of match.slice(1)) {
    const octet = Number(part);

    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }

  return value;
}

function blockedV4(address: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);

    return address >= base && address < base + size;
  });
}

/**
 * Expand an IPv6 literal (without brackets) into eight hextets. The WHATWG URL
 * parser always serializes IPv6 hosts in compressed hexadecimal form, so a
 * dotted IPv4 tail never reaches this function; anything unexpected is rejected.
 */
function parseV6(host: string): readonly number[] | undefined {
  const halves = host.split("::");

  if (halves.length > 2) return undefined;

  const parse = (part: string | undefined): number[] | undefined => {
    if (part === undefined || part === "") return [];
    const out: number[] = [];

    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }

    return out;
  };

  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];

  if (head === undefined || rest === undefined) return undefined;
  const explicit = head.length + rest.length;

  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return undefined;

  return [...head, ...Array<number>(8 - explicit).fill(0), ...rest];
}

function blockedV6(groups: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;

  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96): judge the embedded IPv4 address.
  if (
    (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) ||
    (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
  )
    return blockedV4(g * 0x10000 + h);

  // Only global unicast (2000::/3) can be public. This rejects ::, ::1, fc00::/7,
  // fe80::/10, fec0::/10, ff00::/8, and IPv4-compatible addresses.
  if ((a & 0xe000) !== 0x2000) return true;

  return (
    (a === 0x2001 && b < 0x0200) || // 2001::/23 IETF protocol assignments, including Teredo
    (a === 0x2001 && b === 0x0db8) || // 2001:db8::/32 documentation
    a === 0x2002 || // 2002::/16 6to4, which embeds an arbitrary IPv4 address
    (a === 0x3fff && b < 0x1000) // 3fff::/20 documentation
  );
}

/**
 * Return why a URL must not be fetched, or `undefined` when the static checks
 * pass. Only HTTPS is allowed, `localhost` names are rejected, and IP-literal
 * hosts must be public unicast addresses.
 */
export function egressBlockReason(url: URL): string | undefined {
  if (url.protocol !== "https:") return "only HTTPS URLs are allowed";

  if (url.username || url.password) return "URLs with credentials are not allowed";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (host === "localhost" || host.endsWith(".localhost")) return "localhost is not allowed";

  if (host.startsWith("[") && host.endsWith("]")) {
    const groups = parseV6(host.slice(1, -1));

    return groups === undefined || blockedV6(groups)
      ? "non-public IP addresses are not allowed"
      : undefined;
  }

  const v4 = parseV4(host);

  if (v4 !== undefined && blockedV4(v4)) return "non-public IP addresses are not allowed";

  return undefined;
}
