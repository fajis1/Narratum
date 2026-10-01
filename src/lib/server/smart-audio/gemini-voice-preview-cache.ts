import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { isMissingBlobError } from '@/lib/server/documents/blobstore';
import { getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';

function previewObjectKey(cacheKey: string): string {
  return `${getS3Config().prefix}/gemini_voice_previews_v1/${cacheKey}.wav`;
}

async function responseBodyToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body && typeof body === 'object' && 'transformToByteArray' in body) {
    const value = body as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof value.transformToByteArray === 'function') return Buffer.from(await value.transformToByteArray());
  }
  if (body && typeof body === 'object' && 'on' in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as NodeJS.ReadableStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported Gemini voice preview storage response.');
}

/** Durable cache for neutral, content-free Gemini voice comparison samples. */
export async function getStoredGeminiVoicePreview(cacheKey: string): Promise<Buffer | null> {
  try {
    const cfg = getS3Config();
    const response = await getS3ProxyClient().send(new GetObjectCommand({ Bucket: cfg.bucket, Key: previewObjectKey(cacheKey) }));
    return responseBodyToBuffer(response.Body);
  } catch (error) {
    if (isMissingBlobError(error)) return null;
    throw error;
  }
}

export async function putStoredGeminiVoicePreview(cacheKey: string, audio: Buffer, contentType: string): Promise<void> {
  const cfg = getS3Config();
  await getS3ProxyClient().send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: previewObjectKey(cacheKey),
    Body: audio,
    ContentType: contentType,
    CacheControl: 'private, max-age=31536000, immutable',
    ServerSideEncryption: 'AES256',
  }));
}
