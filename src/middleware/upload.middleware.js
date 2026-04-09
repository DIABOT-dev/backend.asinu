const multer = require('multer');

// Audio upload config
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(m4a|mp3|mp4|wav|webm)$/i.test(file.originalname));
  }
});

// Wrap multer to handle errors as JSON response
function handleUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      next();
    });
  };
}

module.exports = { audioUpload, handleUpload };
