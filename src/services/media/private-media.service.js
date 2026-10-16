const { v2: cloudinary } = require('cloudinary');

const resourceTypeForMime = (mimeType) => {
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  if (normalizedMimeType.startsWith('image/')) return 'image';
  if (normalizedMimeType.startsWith('audio/')) return 'video';
  return 'raw';
};

const configure = () => {
  const {
    CLOUDINARY_CLOUD_NAME: cloud_name,
    CLOUDINARY_API_KEY: api_key,
    CLOUDINARY_API_SECRET: api_secret,
  } = process.env;
  if (!cloud_name || !api_key || !api_secret) {
    const error = new Error('Cloudinary is not configured');
    error.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw error;
  }
  cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
};

const requirePrivateDeliveryConfig = () => {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    const error = new Error('Cloudinary authenticated delivery is not configured');
    error.code = 'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED';
    throw error;
  }
};

const MEDIA_URL_TTL_SECONDS = 300;
const signedDownloads = new Map();
const formatForMime = (mimeType, resourceType) => ({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
}[String(mimeType || '').toLowerCase().split(';')[0]] || (resourceType === 'raw' ? 'pdf' : resourceType === 'video' ? 'mp3' : 'jpg'));

const authenticatedAssetUrl = (publicId, resourceType, deliveryType = 'authenticated', mimeType) => {
  if (!publicId || deliveryType !== 'authenticated') return null;
  requirePrivateDeliveryConfig();
  configure();
  const cacheKey = JSON.stringify([publicId, resourceType, mimeType, process.env.CLOUDINARY_CLOUD_NAME]);
  const now = Math.floor(Date.now() / 1000);
  const cached = signedDownloads.get(cacheKey);
  if (cached && cached.expires > now + 30) return cached.url;
  // Unlike a CDN path signature, the Download API signs and enforces expiry.
  // These are short-lived bearer links; serializers generate a fresh URL only
  // after the caller has passed the existing account/task access checks.
  const expires = now + MEDIA_URL_TTL_SECONDS;
  const url = cloudinary.utils.private_download_url(publicId, formatForMime(mimeType, resourceType), {
    resource_type: resourceType,
    type: 'authenticated',
    expires_at: expires,
    attachment: false,
  });
  if (signedDownloads.size >= 1000) signedDownloads.delete(signedDownloads.keys().next().value);
  signedDownloads.set(cacheKey, { url, expires });
  return url;
};

const isImageBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp =
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return jpeg || png || webp;
};

const isPdfBuffer = (buffer) =>
  Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString('ascii') === '%PDF-';

const isSupportedPatientFile = (buffer, mimeType) => {
  if (mimeType === 'application/pdf') return isPdfBuffer(buffer);
  if (mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp') {
    return isImageBuffer(buffer);
  }
  return false;
};

module.exports = {
  authenticatedAssetUrl,
  MEDIA_URL_TTL_SECONDS,
  requirePrivateDeliveryConfig,
  isSupportedPatientFile,
  resourceTypeForMime,
};
