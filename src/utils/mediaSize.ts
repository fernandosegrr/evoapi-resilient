export type MediaSizeType = 'image' | 'audio' | 'video' | 'document';

const MEBIBYTE = 1024 * 1024;

export const MEDIA_SIZE_LIMITS: Record<MediaSizeType, number> = {
  image: 16 * MEBIBYTE,
  audio: 32 * MEBIBYTE,
  video: 64 * MEBIBYTE,
  document: 100 * MEBIBYTE,
};

export const REMOTE_MEDIA_TIMEOUT_MS = 10_000;

export class MediaSizeLimitError extends Error {
  public readonly code = 'MEDIA_SIZE_LIMIT_EXCEEDED';

  constructor(
    public readonly mediaType: MediaSizeType,
    public readonly limitBytes: number,
    public readonly actualBytes: number,
  ) {
    super(`${mediaType} exceeds the ${formatMediaSize(limitBytes)} size limit`);
    this.name = 'MediaSizeLimitError';
  }
}

export function normalizeMediaSizeType(mediaType: string): MediaSizeType {
  if (mediaType === 'sticker' || mediaType === 'imageMessage' || mediaType === 'stickerMessage') return 'image';
  if (mediaType === 'audioMessage') return 'audio';
  if (mediaType === 'videoMessage' || mediaType === 'ptv' || mediaType === 'ptvMessage') return 'video';
  if (mediaType === 'documentMessage' || mediaType === 'documentWithCaptionMessage') return 'document';
  if (mediaType === 'image' || mediaType === 'audio' || mediaType === 'video' || mediaType === 'document') {
    return mediaType;
  }

  throw new Error(`Unsupported media type: ${mediaType}`);
}

export function getMediaSizeLimit(mediaType: string) {
  return MEDIA_SIZE_LIMITS[normalizeMediaSizeType(mediaType)];
}

export function getMaxBase64Length(mediaType: string) {
  return Math.ceil(getMediaSizeLimit(mediaType) / 3) * 4 + 256;
}

export function formatMediaSize(bytes: number) {
  return `${Math.round(bytes / MEBIBYTE)} MiB`;
}

export function getBase64Payload(value: string) {
  const commaIndex = value.startsWith('data:') ? value.indexOf(',') : -1;
  return commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
}

export function estimateBase64DecodedSize(value: string) {
  const payload = getBase64Payload(value);
  if (!payload) return 0;

  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function assertBase64MediaSize(value: string, mediaType: string) {
  const normalizedType = normalizeMediaSizeType(mediaType);
  const estimatedBytes = estimateBase64DecodedSize(value);
  const limitBytes = MEDIA_SIZE_LIMITS[normalizedType];

  if (estimatedBytes > limitBytes) {
    throw new MediaSizeLimitError(normalizedType, limitBytes, estimatedBytes);
  }
}

export function assertBufferMediaSize(buffer: Buffer, mediaType: string) {
  const normalizedType = normalizeMediaSizeType(mediaType);
  const limitBytes = MEDIA_SIZE_LIMITS[normalizedType];

  if (buffer.length > limitBytes) {
    throw new MediaSizeLimitError(normalizedType, limitBytes, buffer.length);
  }
}

export function decodeBase64Media(value: string, mediaType: string) {
  assertBase64MediaSize(value, mediaType);
  const buffer = Buffer.from(getBase64Payload(value), 'base64');
  assertBufferMediaSize(buffer, mediaType);
  return buffer;
}

export function parseMediaFileLength(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') return value >= 0 ? Number(value) : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  if (value && typeof value === 'object') {
    const longValue = value as { low?: number; high?: number; toNumber?: () => number };
    if (typeof longValue.toNumber === 'function') {
      const parsed = longValue.toNumber();
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    if (typeof longValue.low === 'number') {
      const high = typeof longValue.high === 'number' ? longValue.high : 0;
      const parsed = high * 2 ** 32 + (longValue.low >>> 0);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
  }

  return null;
}

export function assertDeclaredMediaSize(fileLength: unknown, mediaType: string) {
  const parsedLength = parseMediaFileLength(fileLength);
  if (parsedLength === null) return;

  const normalizedType = normalizeMediaSizeType(mediaType);
  const limitBytes = MEDIA_SIZE_LIMITS[normalizedType];
  if (parsedLength > limitBytes) {
    throw new MediaSizeLimitError(normalizedType, limitBytes, parsedLength);
  }
}
