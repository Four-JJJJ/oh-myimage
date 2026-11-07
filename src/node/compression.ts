import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export type StaticEncoding = "br" | "gzip";

const COMPRESSIBLE_CONTENT_TYPE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;
const MIN_COMPRESS_BYTES = 1024;

/** Static file extensions worth compressing (fonts/images are already compressed). */
export const COMPRESSIBLE_STATIC_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt", ".map", ".webmanifest"]);

function acceptedEncodings(acceptEncoding: string | null | undefined): Set<string> {
  const accepted = new Set<string>();
  if (!acceptEncoding) return accepted;
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    accepted.add(name);
  }
  return accepted;
}

/** Ordered list of precompressed variants the client accepts, best first. */
export function preferredStaticEncodings(acceptEncoding: string | null | undefined): StaticEncoding[] {
  const accepted = acceptedEncodings(acceptEncoding);
  const result: StaticEncoding[] = [];
  if (accepted.has("br")) result.push("br");
  if (accepted.has("gzip") || accepted.has("*")) result.push("gzip");
  return result;
}

export function isCompressibleContentType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && COMPRESSIBLE_CONTENT_TYPE.test(contentType));
}

/**
 * Gzip a dynamic (API) response when the client accepts it and the payload is textual.
 * Images and other binary streams are passed through untouched.
 */
export function maybeCompressResponse(request: Request, response: Response): Response {
  if (request.method === "HEAD" || !response.body) return response;
  if (response.status < 200 || response.status === 204 || response.status === 206 || response.status === 304) return response;
  const headers = response.headers;
  if (headers.has("Content-Encoding")) return response;
  if (!isCompressibleContentType(headers.get("Content-Type"))) return response;
  if (/\bno-transform\b/i.test(headers.get("Cache-Control") ?? "")) return response;
  const contentLength = headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) < MIN_COMPRESS_BYTES) return response;
  if (!acceptedEncodings(request.headers.get("Accept-Encoding")).has("gzip")) return response;

  const nextHeaders = new Headers(headers);
  nextHeaders.set("Content-Encoding", "gzip");
  nextHeaders.delete("Content-Length");
  appendVary(nextHeaders, "Accept-Encoding");
  return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
}

export function appendVary(headers: Headers, value: string): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }
  const values = current.split(",").map((item) => item.trim().toLowerCase());
  if (values.includes("*") || values.includes(value.toLowerCase())) return;
  headers.set("Vary", `${current}, ${value}`);
}

export interface CompressedAsset {
  encoding: StaticEncoding;
  body: Buffer;
}

export interface StaticFileIdentity {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * In-memory cache of brotli/gzip variants for static build assets.
 * Assets are compressed once (off the event loop via zlib's thread pool) and
 * reused for every subsequent request, so the hot path is a Map lookup.
 */
export class StaticCompressionCache {
  private readonly entries = new Map<string, Promise<Partial<Record<StaticEncoding, Buffer>> | null>>();

  constructor(private readonly maxFileBytes = 8 * 1024 * 1024) {}

  async get(file: StaticFileIdentity, encodings: StaticEncoding[]): Promise<CompressedAsset | null> {
    if (encodings.length === 0 || file.size < MIN_COMPRESS_BYTES || file.size > this.maxFileBytes) return null;
    const key = `${file.path}\u0000${file.size}\u0000${file.mtimeMs}`;
    let pending = this.entries.get(key);
    if (!pending) {
      pending = compressFile(file.path).catch(() => null);
      this.entries.set(key, pending);
    }
    const variants = await pending;
    if (!variants) return null;
    for (const encoding of encodings) {
      const body = variants[encoding];
      if (body) return { encoding, body };
    }
    return null;
  }
}

async function compressFile(path: string): Promise<Partial<Record<StaticEncoding, Buffer>> | null> {
  const source = await readFile(path);
  const [br, gz] = await Promise.all([
    brotliCompressAsync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
      },
    }),
    gzipAsync(source, { level: 9 }),
  ]);
  const variants: Partial<Record<StaticEncoding, Buffer>> = {};
  // Only keep variants that actually save bytes.
  if (br.byteLength < source.byteLength) variants.br = br;
  if (gz.byteLength < source.byteLength) variants.gzip = gz;
  return variants;
}
