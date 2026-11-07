import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { appendVary, maybeCompressResponse, preferredStaticEncodings, StaticCompressionCache } from "./compression";

const largeJson = JSON.stringify({ ok: true, records: Array.from({ length: 200 }, (_, index) => ({ id: `job_${index}`, prompt: "a cat on the moon" })) });

function request(acceptEncoding?: string, method = "GET"): Request {
  return new Request("http://localhost/api/generations", {
    method,
    headers: acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {},
  });
}

describe("preferredStaticEncodings", () => {
  it("prefers brotli over gzip and honours q=0", () => {
    expect(preferredStaticEncodings("gzip, deflate, br")).toEqual(["br", "gzip"]);
    expect(preferredStaticEncodings("gzip;q=1.0, br;q=0")).toEqual(["gzip"]);
    expect(preferredStaticEncodings("identity")).toEqual([]);
    expect(preferredStaticEncodings(undefined)).toEqual([]);
  });
});

describe("maybeCompressResponse", () => {
  it("gzips large JSON API responses", async () => {
    const response = maybeCompressResponse(request("gzip, br"), new Response(largeJson, { headers: { "Content-Type": "application/json" } }));
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Vary")).toBe("Accept-Encoding");
    const body = Buffer.from(await response.arrayBuffer());
    expect(gunzipSync(body).toString("utf8")).toBe(largeJson);
  });

  it("keeps status and existing headers", () => {
    const response = maybeCompressResponse(
      request("gzip"),
      new Response(largeJson, { status: 409, headers: { "Content-Type": "application/json", "Set-Cookie": "a=b", Vary: "Origin" } }),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("Set-Cookie")).toBe("a=b");
    expect(response.headers.get("Vary")).toBe("Origin, Accept-Encoding");
  });

  it("passes through binary, small, already-encoded, or non-accepting responses", () => {
    const image = new Response(new Uint8Array(4096), { headers: { "Content-Type": "image/png" } });
    expect(maybeCompressResponse(request("gzip"), image)).toBe(image);

    const small = new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "2" } });
    expect(maybeCompressResponse(request("gzip"), small)).toBe(small);

    const encoded = new Response(largeJson, { headers: { "Content-Type": "application/json", "Content-Encoding": "br" } });
    expect(maybeCompressResponse(request("gzip"), encoded)).toBe(encoded);

    const plain = new Response(largeJson, { headers: { "Content-Type": "application/json" } });
    expect(maybeCompressResponse(request(), plain)).toBe(plain);

    const noTransform = new Response(largeJson, { headers: { "Content-Type": "application/json", "Cache-Control": "no-transform" } });
    expect(maybeCompressResponse(request("gzip"), noTransform)).toBe(noTransform);

    const notModified = new Response(null, { status: 304, headers: { "Content-Type": "application/json" } });
    expect(maybeCompressResponse(request("gzip"), notModified)).toBe(notModified);
  });
});

describe("appendVary", () => {
  it("does not duplicate existing values", () => {
    const headers = new Headers({ Vary: "accept-encoding" });
    appendVary(headers, "Accept-Encoding");
    expect(headers.get("Vary")).toBe("accept-encoding");
  });
});

describe("StaticCompressionCache", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns brotli or gzip variants that round-trip and reuses the cached result", async () => {
    dir = await mkdtemp(join(tmpdir(), "oh-myimage-compression-"));
    const path = join(dir, "index.js");
    const source = "export const value = 1;\n".repeat(500);
    await writeFile(path, source);
    const stats = await stat(path);
    const file = { path, size: stats.size, mtimeMs: stats.mtimeMs };
    const cache = new StaticCompressionCache();

    const br = await cache.get(file, ["br", "gzip"]);
    expect(br?.encoding).toBe("br");
    expect(brotliDecompressSync(br!.body).toString("utf8")).toBe(source);

    const gz = await cache.get(file, ["gzip"]);
    expect(gz?.encoding).toBe("gzip");
    expect(gunzipSync(gz!.body).toString("utf8")).toBe(source);

    expect((await cache.get(file, ["br"]))?.body).toBe(br!.body);
    expect(await cache.get(file, [])).toBeNull();
    expect(await cache.get({ ...file, size: 10 }, ["br"])).toBeNull();
  });
});
