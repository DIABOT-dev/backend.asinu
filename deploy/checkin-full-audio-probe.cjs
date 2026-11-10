'use strict';

// Fixed synthetic content only; do not create users, health records or alerts.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const fromRoot = createRequire(require('node:path').join(process.cwd(), 'package.json'));
const { withPublicAiTemplate } = fromRoot('./src/services/ai/ai-consent.service');
const audio = fromRoot('./src/services/checkin-call/audio.service');
const conclusion = fromRoot('./src/services/checkin-call/conclusion-audio.service');

function decodedSeconds(buffer) {
  const decoded = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-progress',
      'pipe:1',
      '-f',
      'null',
      '-',
    ],
    { input: buffer, encoding: 'buffer', timeout: 30000, maxBuffer: 2_000_000 }
  );
  assert.equal(decoded.status, 0, 'Generated recording must decode completely');
  const timestamps = [...decoded.stdout.toString('utf8').matchAll(/out_time_us=(\d+)/g)];
  const seconds = Number(timestamps.at(-1)?.[1]) / 1_000_000;
  assert.ok(seconds > 0, 'Recording must contain audible frames');
  return seconds;
}

(async () => {
  assert.equal(typeof conclusion.prepareConclusionAudio, 'function', 'New audio service required');
  let text = '',
    number = 0;
  while (text.length < 5300)
    text += `Đoạn kiểm tra số ${++number}, đây là nội dung mô phỏng của Asinu để xác nhận toàn bộ phần kết luận và lời khuyên đều có trong bản ghi âm. `;
  text += `Câu xác nhận cuối cùng của bản thử nghiệm ${Date.now()} đã được đọc đầy đủ.`;
  const expected = conclusion.conclusionText(text, 'vi');
  const segments = [];
  const synthesize = audio.synthesizeText;
  audio.synthesizeText = async (...args) => {
    const segment = { text: args[0], started: Date.now() };
    segments.push(segment);
    const result = await synthesize(...args);
    segment.duration_ms = Date.now() - segment.started;
    segment.data = result.audio_data;
    return result;
  };
  const userId = 2_147_483_647; // Cache identity only; no database access.
  const started = Date.now();
  const waitStarted = await withPublicAiTemplate(async () => {
    await conclusion.prepareConclusionAudio(
      userId,
      {
        isDone: true,
        conclusionVersion: 2,
        severity: 'medium',
        speechText: expected,
      },
      'vi'
    );
    return Date.now();
  });
  const recording = await withPublicAiTemplate(() =>
    conclusion.getConclusionAudio(userId, expected, 'vi')
  );
  const clientWaitMs = Date.now() - waitStarted;
  assert.equal(recording.mime_type, 'audio/mpeg');
  assert.ok(segments.length > 1, 'The test must exercise long speech segmentation');
  assert.equal(
    segments.map((segment) => segment.text).join(' '),
    expected,
    'Every character including the last sentence must reach TTS in order'
  );
  const segmentDurations = segments.map((segment) => decodedSeconds(segment.data));
  const totalSeconds = decodedSeconds(recording.audio_data);
  const expectedSeconds = segmentDurations.reduce((sum, value) => sum + value, 0);
  assert.ok(
    Math.abs(totalSeconds - expectedSeconds) < Math.max(0.5, segments.length * 0.1),
    'Complete MP3 must include all decoded segments, including its tail'
  );
  const callsBeforeReplay = segments.length,
    replayStarted = Date.now();
  const replay = await withPublicAiTemplate(() =>
    conclusion.getConclusionAudio(userId, expected, 'vi')
  );
  assert.equal(segments.length, callsBeforeReplay, 'Replay must reuse the full recording');
  assert.equal(
    createHash('sha256').update(replay.audio_data).digest('hex'),
    createHash('sha256').update(recording.audio_data).digest('hex')
  );
  console.log(
    JSON.stringify({
      synthetic_full_audio_probe: true,
      input_chars: expected.length,
      segment_count: segments.length,
      all_text_sent_in_order: true,
      tail_preserved: true,
      mime_type: recording.mime_type,
      complete_audio_seconds: Number(totalSeconds.toFixed(3)),
      segment_audio_seconds: segmentDurations.map((value) => Number(value.toFixed(3))),
      audio_bytes: recording.audio_data.length,
      synthesis_ms: waitStarted - started + clientWaitMs,
      prewarm_wait_ms: waitStarted - started,
      client_wait_ms: clientWaitMs,
      preview38_within_audio_timeout: clientWaitMs < 30000,
      replay_ms: Date.now() - replayStarted,
      database_writes: false,
      notifications_sent: false,
    })
  );
})().catch((error) => {
  console.error(
    JSON.stringify({
      synthetic_full_audio_probe_failed: true,
      code: error.code || error.name,
      reason:
        error instanceof assert.AssertionError
          ? error.message.split('\n')[0]
          : 'Audio preparation failed',
    })
  );
  process.exitCode = 1;
});
