'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const run = promisify(execFile);

// Only local bytes are passed to ffprobe. Never trust client duration or pass a URL.
async function inspectRecording(buffer, maximum) {
  const directory = await mkdtemp(path.join(tmpdir(), 'asinu-ivr-'));
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
    const info = JSON.parse(stdout),
      duration = Number(
        info.format?.duration || info.streams?.find((s) => s.codec_type === 'audio')?.duration
      );
    if (
      !info.streams?.some((s) => s.codec_type === 'audio') ||
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > maximum + 0.5
    )
      throw new Error('Invalid duration');
    return duration;
  } catch (e) {
    const unavailable = e.code === 'ENOENT';
    throw Object.assign(
      new Error(
        unavailable
          ? 'Chưa cấu hình kiểm tra ghi âm.'
          : 'Ghi âm không hợp lệ hoặc quá thời lượng cho phép.'
      ),
      {
        code: unavailable ? 'IVR_AUDIO_NOT_CONFIGURED' : 'IVR_INVALID_AUDIO_DURATION',
        statusCode: unavailable ? 503 : 400,
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
module.exports = { inspectRecording };
