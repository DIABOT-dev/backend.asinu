const { v2: cloudinary } = require('cloudinary');

let configured = false;

function configureCloudinary() {
  if (configured) return;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    const error = new Error('Cloudinary is not configured');
    error.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw error;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  configured = true;
}

function uploadBuffer(buffer, options) {
  configureCloudinary();

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      return resolve(result);
    });

    uploadStream.end(buffer);
  });
}

/**
 * Uploads one user's avatar. A stable public_id means a new avatar replaces
 * the previous asset instead of creating an unbounded number of files.
 */
async function uploadAvatar(buffer, userId) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error('Avatar buffer is empty');
    error.code = 'INVALID_AVATAR_BUFFER';
    throw error;
  }

  const result = await uploadBuffer(buffer, {
    folder: process.env.CLOUDINARY_AVATAR_FOLDER || 'asinu/avatars',
    public_id: `user_${String(userId)}`,
    resource_type: 'image',
    overwrite: true,
    invalidate: true,
    transformation: [
      { width: 512, height: 512, crop: 'fill', gravity: 'auto' },
      { quality: 'auto', fetch_format: 'auto' },
    ],
  });

  return {
    secureUrl: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
  };
}

module.exports = { uploadAvatar };
