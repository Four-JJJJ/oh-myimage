import { Env } from "./types";

export interface BaseUrlValidation {
  ok: boolean;
  normalized?: string;
  error?: string;
}

export interface ResolvedBaseUrlAddress {
  address: string;
  family?: 4 | 6;
}

export type BaseUrlAddressResolver = (hostname: string) => Promise<Array<string | ResolvedBaseUrlAddress>>;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
]);

const IPV4_BLOCKED_CIDRS: Array<[base: string, prefix: number, reason: string]> = [
  ["0.0.0.0", 8, "current_network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier_grade_nat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link_local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

const IPV6_BLOCKED_CIDRS: Array<[base: string, prefix: number, reason: string]> = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["::ffff:0:0", 96, "ipv4_mapped"],
  ["64:ff9b:1::", 48, "private_translation"],
  ["100::", 64, "discard"],
  ["2001::", 32, "teredo"],
  ["2001:2::", 48, "benchmarking"],
  ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4"],
  ["fc00::", 7, "unique_local"],
  ["fe80::", 10, "link_local"],
  ["ff00::", 8, "multicast"],
];

export function normalizeSpaceName(spaceName: string): { displayName: string; key: string } {
  const displayName = spaceName.trim().replace(/\s+/g, " ");
  return { displayName, key: displayName.toLowerCase() };
}

export function validateBaseURL(value: string): BaseUrlValidation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "baseURL 必须是合法 URL。" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "baseURL 必须使用 HTTPS。" };
  }

  if (url.username || url.password) {
    return { ok: false, error: "baseURL 不能包含用户名或密码。" };
  }

  if (url.search || url.hash) {
    return { ok: false, error: "baseURL 不能包含查询参数或 hash。" };
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { ok: false, error: "baseURL 主机不允许访问。" };
  }

  if (isIpLiteral(hostname)) {
    return { ok: false, error: "baseURL 不允许使用 IP 地址，请使用公开域名。" };
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = normalizedPath === "/" ? "" : normalizedPath;
  return { ok: true, normalized: url.toString().replace(/\/$/, "") };
}

export async function validateResolvedBaseURL(value: string, resolveAddresses: BaseUrlAddressResolver): Promise<BaseUrlValidation> {
  const validation = validateBaseURL(value);
  if (!validation.ok || !validation.normalized) return validation;

  const hostname = normalizeHostname(new URL(validation.normalized).hostname);
  let resolvedAddresses: Array<string | ResolvedBaseUrlAddress>;
  try {
    resolvedAddresses = await resolveAddresses(hostname);
  } catch {
    return { ok: false, error: "baseURL 主机 DNS 解析失败，无法确认安全性。" };
  }

  if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length === 0) {
    return { ok: false, error: "baseURL 主机 DNS 未返回可验证地址。" };
  }

  for (const resolved of resolvedAddresses) {
    const address = typeof resolved === "string" ? resolved : resolved.address;
    if (typeof address !== "string") {
      return { ok: false, error: "baseURL DNS 解析返回了无法识别的地址。" };
    }
    const reason = getUnsafeIPAddressReason(address);
    if (reason) {
      return { ok: false, error: `baseURL DNS 解析到不允许访问的地址：${reason}。` };
    }
  }

  return validation;
}

export function buildProviderEndpoint(baseURL: string, endpoint: string): string {
  const base = new URL(baseURL);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function isTokenFourjBaseURL(baseURL: string): boolean {
  try {
    return ["token.fourj.space", "image.fourj.space"].includes(new URL(baseURL).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isUnsafeIPAddress(address: string): boolean {
  return getUnsafeIPAddressReason(address) !== undefined;
}

export function getUnsafeIPAddressReason(address: string): string | undefined {
  const parsed = parseIPAddress(address);
  if (!parsed) return "invalid_ip";

  if (parsed.version === 4) {
    for (const [base, prefix, reason] of IPV4_BLOCKED_CIDRS) {
      const baseInt = parseIPv4ToInt(base);
      if (baseInt !== undefined && ipv4InCidr(parsed.value, baseInt, prefix)) return reason;
    }
    return undefined;
  }

  for (const [base, prefix, reason] of IPV6_BLOCKED_CIDRS) {
    const baseInt = parseIPv6ToBigInt(base);
    if (baseInt !== undefined && ipv6InCidr(parsed.value, baseInt, prefix)) return reason;
  }

  const globalUnicastBase = parseIPv6ToBigInt("2000::");
  if (globalUnicastBase !== undefined && !ipv6InCidr(parsed.value, globalUnicastBase, 3)) return "reserved";

  return undefined;
}

function isIpLiteral(hostname: string): boolean {
  return parseIPAddress(hostname) !== undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function parseIPAddress(address: string): { version: 4; value: number } | { version: 6; value: bigint } | undefined {
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith("[") || normalized.endsWith("]")) {
    if (!normalized.startsWith("[") || !normalized.endsWith("]")) return undefined;
    normalized = normalized.slice(1, -1);
  }
  const withoutZone = normalized.split("%", 1)[0];
  const ipv4 = parseIPv4ToInt(withoutZone);
  if (ipv4 !== undefined) return { version: 4, value: ipv4 };

  const ipv6 = parseIPv6ToBigInt(withoutZone);
  if (ipv6 !== undefined) return { version: 6, value: ipv6 };

  return undefined;
}

function parseIPv4ToInt(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8) + octet;
  }

  return value >>> 0;
}

function parseIPv6ToBigInt(address: string): bigint | undefined {
  if (!address || address.includes(":::")) return undefined;

  let value = address;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) return undefined;

    const ipv4 = parseIPv4ToInt(value.slice(lastColon + 1));
    if (ipv4 === undefined) return undefined;

    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    value = `${value.slice(0, lastColon)}:${high}:${low}`;
  }

  const compressed = value.split("::");
  if (compressed.length > 2) return undefined;

  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  if (left.some((part) => part === "") || right.some((part) => part === "")) return undefined;

  const missing = 8 - left.length - right.length;
  if (compressed.length === 1 && missing !== 0) return undefined;
  if (compressed.length === 2 && missing < 1) return undefined;

  const groups = [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right];
  if (groups.length !== 8) return undefined;

  let parsed = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    parsed = (parsed << 16n) + BigInt(parseInt(group, 16));
  }

  return parsed;
}

function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

function ipv6InCidr(value: bigint, base: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

export async function verifyTurnstile(token: string | undefined, request: Request, env: Env): Promise<boolean> {
  const required = env.TURNSTILE_REQUIRED === "true";
  if (!env.TURNSTILE_SECRET_KEY) return !required;
  if (!token) return false;

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}
