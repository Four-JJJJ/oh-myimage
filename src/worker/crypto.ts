const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PASSWORD_ITERATIONS = 100_000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function passwordKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(encoder.encode(password)), "PBKDF2", false, ["deriveBits"]);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await passwordKey(password);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationText, saltText, hashText] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterationText || !saltText || !hashText) return false;
  const iterations = Number(iterationText);
  if (!Number.isInteger(iterations) || iterations < 50_000) return false;
  const salt = base64UrlToBytes(saltText);
  const expected = base64UrlToBytes(hashText);
  const key = await passwordKey(password);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    key,
    256,
  );
  return timingSafeEqual(new Uint8Array(bits), expected);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error("APP_ENCRYPTION_KEY 至少需要 16 个字符。");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plainText: string, secret: string): Promise<string> {
  const iv = randomBytes(12);
  const key = await aesKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(plainText)),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(payload: string, secret: string): Promise<string> {
  const [version, ivText, cipherText] = payload.split(".");
  if (version !== "v1" || !ivText || !cipherText) {
    throw new Error("密钥密文格式不正确。");
  }
  const key = await aesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64UrlToBytes(ivText)) },
    key,
    toArrayBuffer(base64UrlToBytes(cipherText)),
  );
  return decoder.decode(decrypted);
}

export function makeSessionToken(): string {
  return bytesToBase64Url(randomBytes(32));
}

export function apiKeyHint(apiKey: string): string {
  if (apiKey.length <= 8) return "configured";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

export function bytesFromBase64(value: string): Uint8Array {
  return base64ToBytes(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
