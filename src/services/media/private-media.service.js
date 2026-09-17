const { v2: cloudinary } = require('cloudinary');

const privateUrlTtlSeconds = () =>
  Number.parseInt(process.env.CLOUDINARY_ASSET_URL_TTL_SECONDS || '300', 10);
const authTokenKey = () => process.env.CLOUDINARY_AUTH_TOKEN_KEY || '';

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
  const key = authTokenKey();
  const ttlSeconds = privateUrlTtlSeconds();
  if (!key || !/^[0-9a-f]{32,}$/i.test(key)) {
    const error = new Error('Cloudinary authenticated delivery is not configured');
    error.code = 'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED';
    throw error;
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
    const error = new Error('Cloudinary private URL TTL is invalid');
    error.code = 'CLOUDINARY_PRIVATE_DELIVERY_NOT_CONFIGURED';
    throw error;
  }
  return { key, ttlSeconds };
};

const authenticatedAssetUrl = (publicId, resourceType, deliveryType = 'authenticated') => {
  if (!publicId || deliveryType !== 'authenticated') return null;
  const { key, ttlSeconds } = requirePrivateDeliveryConfig();
  configure();
  return cloudinary.url(publicId, {
    secure: true,
    resource_type: resourceType,
    type: 'authenticated',
    sign_url: true,
    auth_token: { key, duration: ttlSeconds },
  });
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
  requirePrivateDeliveryConfig,
  isSupportedPatientFile,
  resourceTypeForMime,
};
