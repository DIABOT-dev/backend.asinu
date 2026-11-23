'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const logger = require('../../lib/logger');
const run = promisify(execFile);

// Only local bytes are passed to ffprobe. Never trust client duration or pass a URL.
async function inspectRecording(buffer, maximum) {
  const directory = await mkdtemp(path.join(tmpdir(), 'asinu-ivr-'));
  let reason = 'probe_failed';
  let duration;
  try {
    const file = path.join(directory, 'recording');
    await writeFile(file, buffer, { mode: 0o600 });
    const { stdout } = await run(
      process.env.FFPROBE_PATH || 'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,crypto,data',
        '-show_entries',
        'format=duration:stream=codec_type,duration',
        '-of',
        'json',
        file,
      ],
      { timeout: 8000, maxBuffer: 16384 }
    );
    const info = JSON.parse(stdout);
    const audio = info.streams?.find((s) => s.codec_type === 'audio');
    duration = Number(info.format?.duration || audio?.duration);
    if (
      !audio ||
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > maximum + 0.5
    ) {
      reason = !audio ? 'missing_audio_track'
        : !Number.isFinite(duration) ? 'missing_duration'
        : duration < 1 ? 'too_short' : 'too_long';
      throw new Error('Invalid duration');
    }
    return duration;
  } catch (e) {
    const unavailable = e.code === 'ENOENT';
    if (reason === 'probe_failed' && typeof e.stderr === 'string') {
      if (e.stderr.includes('moov atom not found')) reason = 'unfinalized_mp4';
      else if (e.stderr.includes('not on whitelist')) reason = 'probe_protocol_denied';
      else if (e.stderr.includes('Invalid data')) reason = 'malformed_media';
    }
    logger.warn('doctor_ivr.recording_rejected', {
      reason: unavailable ? 'probe_unavailable' : reason,
      bytes: buffer.length,
      duration: Number.isFinite(duration) ? duration : null,
      maximum,
      probeExit: Number.isInteger(e.code) ? e.code : undefined,
    });
    throw Object.assign(
      new Error(
        unavailable
          ? 'Chưa cấu hình kiểm tra ghi âm.'
          : 'Ghi âm không hợp lệ hoặc quá thời lượng cho phép.'
      ),
      {
        code: unavailable ? 'IVR_AUDIO_NOT_CONFIGURED'
          : reason === 'too_short' ? 'IVR_AUDIO_TOO_SHORT'
          : 'IVR_INVALID_AUDIO_DURATION',
        statusCode: unavailable ? 503 : 400,
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
module.exports = { inspectRecording };
