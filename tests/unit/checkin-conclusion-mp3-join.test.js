'use strict';

const { spawnSync } = require('node:child_process');
const { encodeMp3, concatenateMp3 } = require('../../src/services/voice/mp3.service');
const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const realCodecTest = available ? test : test.skip;
jest.setTimeout(20000);

function ffmpeg(arguments_, input) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...arguments_], {
    input,
    maxBuffer: 20_000_000,
    timeout: 15000,
  });
  if (result.status !== 0) throw new Error('Synthetic audio fixture failed');
  return result.stdout;
}

function decode(input) {
  const bytes = ffmpeg(
    ['-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '24000', 'pipe:1'],
    input
  );
  return Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
}

function frequencyEnergy(samples, start, frequency) {
  let sine = 0,
    cosine = 0;
  for (let offset = 0; offset < 1500; offset++) {
    const value = samples[start + offset] || 0;
    const phase = (2 * Math.PI * frequency * offset) / 24000;
    sine += value * Math.sin(phase);
    cosine += value * Math.cos(phase);
  }
  return sine * sine + cosine * cosine;
}

realCodecTest(
  'the finished MP3 decodes every segment, including the final one, in order',
  async () => {
    const frequencies = [440, 660, 880];
    const clips = [];
    for (const frequency of frequencies) {
      const wav = ffmpeg([
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${frequency}:duration=0.4:sample_rate=24000`,
        '-ac',
        '1',
        '-f',
        'wav',
        'pipe:1',
      ]);
      clips.push((await encodeMp3(wav)).audio_data);
    }
    const combined = await concatenateMp3(clips);
    expect(combined.mime_type).toBe('audio/mpeg');
    const samples = decode(combined.audio_data);
    const sourceSamples = clips.reduce((length, clip) => length + decode(clip).length, 0);
    expect(samples.length).toBeGreaterThanOrEqual(sourceSamples - 1000);
    for (const [index, frequency] of frequencies.entries()) {
      const start = Math.floor((samples.length * (index + 0.45)) / frequencies.length);
      const correct = frequencyEnergy(samples, start, frequency);
      for (const other of frequencies.filter((value) => value !== frequency))
        expect(correct).toBeGreaterThan(frequencyEnergy(samples, start, other) * 10);
    }
  }
);

realCodecTest(
  'a corrupt later segment fails the recording instead of returning only the valid beginning',
  async () => {
    const wav = ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.1:sample_rate=24000',
      '-ac',
      '1',
      '-f',
      'wav',
      'pipe:1',
    ]);
    const first = await encodeMp3(wav);
    await expect(
      concatenateMp3([first.audio_data, Buffer.from('not an audio recording')])
    ).rejects.toThrow('Conclusion audio joining failed');
  }
);
