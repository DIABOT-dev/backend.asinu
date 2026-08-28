const { v2: cloudinary } = require('cloudinary');
let configured = false;
const configure = () => {
  if (configured) return;
  const { CLOUDINARY_CLOUD_NAME: cloud_name, CLOUDINARY_API_KEY: api_key, CLOUDINARY_API_SECRET: api_secret } = process.env;
  if (!cloud_name || !api_key || !api_secret) {
    const error = new Error('Cloudinary is not configured');
    error.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw error;
  }
  cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
  configured = true;
};
const uploadBuffer = (buffer, options) => new Promise((resolve, reject) => {
  configure();
  const stream = cloudinary.uploader.upload_stream(options, (error, result) => error ? reject(error) : resolve(result));
  stream.end(buffer);
});
module.exports = { uploadBuffer };
