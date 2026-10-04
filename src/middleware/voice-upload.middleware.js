const multer = require('multer');
const { t, getLang } = require('../i18n');

// Voice-chat uploads have their own MIME policy; the signature is checked
// separately by verifyAudioMagicBytes after Multer has populated req.file.
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'audio/m4a',
      'audio/mp4',
      'audio/webm',
      'audio/ogg',
      'audio/wav',
      'audio/mpeg',
    ];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error(t('error.audio_only', getLang(req))), false);
    }
  },
});

module.exports = { voiceUpload };
