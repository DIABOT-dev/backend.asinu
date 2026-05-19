const multer = require('multer');
const { t, getLang } = require('../i18n');

const ALLOWED_AUDIO_MIMETYPES = new Set([
  'audio/m4a',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
]);

const ALLOWED_AUDIO_EXTENSIONS = /\.(m4a|mp3|mp4|wav|webm|ogg)$/i;

// Audio upload config: extension + MIME type check at filter,
// magic-bytes verification runs separately after multer has the buffer.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, was 25MB
  fileFilter: (req, file, cb) => {
    const extOk = ALLOWED_AUDIO_EXTENSIONS.test(file.originalname);
    const mimeOk =
      ALLOWED_AUDIO_MIMETYPES.has(file.mimetype) ||
      file.mimetype.startsWith('audio/');
    if (extOk && mimeOk) return cb(null, true);
    return cb(new Error(t('error.invalid_audio_file', getLang(req)) || 'Invalid audio file'), false);
  },
});

/**
 * Inspect the first bytes of an audio buffer and confirm it matches a known
 * audio container signature. Returns true for: MP3, M4A/MP4, WAV, WebM, OGG.
 */
function isAudioBuffer(buf) {
  if (!buf || buf.length < 12) return false;

  // ID3 tag (often prefixes MP3)
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // MPEG frame sync (MP3 without ID3): 0xFF Ex/Fx
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  // RIFF....WAVE (WAV)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) return true;
  // OggS (OGG)
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;
  // EBML header 1A 45 DF A3 (WebM/Matroska)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  // ftyp box at offset 4 (M4A / MP4 container)
  if (
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) return true;

  return false;
}

/**
 * Run after multer.single(...) — rejects requests whose buffer does not
 * match a known audio container signature.
 */
function verifyAudioMagicBytes(req, res, next) {
  const file = req.file;
  if (!file || !file.buffer) {
    return res.status(400).json({ ok: false, error: t('error.no_file_uploaded', getLang(req)) || 'No file uploaded' });
  }
  if (!isAudioBuffer(file.buffer)) {
    return res.status(400).json({ ok: false, error: t('error.invalid_audio_file', getLang(req)) || 'Invalid audio file' });
  }
  return next();
}

// Wrap multer to handle errors as JSON response
function handleUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      next();
    });
  };
}

module.exports = { audioUpload, handleUpload, verifyAudioMagicBytes, isAudioBuffer };
