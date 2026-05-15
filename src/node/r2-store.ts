import { Readable } from "node:stream";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, GetObjectCommandOutput, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppObject, AppObjectStore, AppObjectStorePutOptions } from "../worker/types";

export interface R2StoreConfig {
  accountId?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Store(config: R2StoreConfig): AppObjectStore {
  const endpoint = config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return new S3ObjectStore(client, config.bucket);
}

class S3ObjectStore implements AppObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: AppObjectStorePutOptions,
  ): Promise<unknown> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: await toS3Body(value),
        ContentType: options?.httpMetadata?.contentType,
        ContentDisposition: options?.httpMetadata?.contentDisposition,
        Metadata: options?.customMetadata,
      }),
    );
    return {};
  }

  async get(key: string): Promise<AppObject | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      return new S3Object(result);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw error;
    }
  }

  async copy(sourceKey: string, destinationKey: string, options?: AppObjectStorePutOptions): Promise<unknown> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: s3CopySource(this.bucket, sourceKey),
        ContentType: options?.httpMetadata?.contentType,
        ContentDisposition: options?.httpMetadata?.contentDisposition,
        Metadata: options?.customMetadata,
        MetadataDirective: "REPLACE",
      }),
    );
    return {};
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createPresignedGetUrl(
    key: string,
    options?: {
      expiresInSeconds?: number;
      contentType?: string;
      contentDisposition?: string;
    },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: options?.contentType,
      ResponseContentDisposition: options?.contentDisposition,
    });
    return getSignedUrl(this.client, command, { expiresIn: options?.expiresInSeconds ?? 300 });
  }
}

function s3CopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

class S3Object implements AppObject {
  readonly httpMetadata: AppObject["httpMetadata"];

  constructor(private readonly result: GetObjectCommandOutput) {
    this.httpMetadata = {
      contentType: result.ContentType,
      contentDisposition: result.ContentDisposition,
    };
  }

  get body(): ReadableStream | null {
    const body = this.result.Body;
    return body ? toWebStream(body) : null;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const body = this.result.Body;
    if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
      const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      return toArrayBuffer(bytes);
    }
    if (!this.body) return new ArrayBuffer(0);
    return new Response(this.body).arrayBuffer();
  }
}

async function toS3Body(value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string): Promise<Buffer | Readable | string> {
  if (typeof value === "string") return value;
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Readable.fromWeb(value as never);
}

function toWebStream(body: unknown): ReadableStream {
  if (typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    return (body as { transformToWebStream(): ReadableStream }).transformToWebStream();
  }
  if (body instanceof Readable) return Readable.toWeb(body) as ReadableStream;
  throw new Error("Unsupported S3 response body stream.");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
