const { isAudioBuffer } = require('../../src/middleware/upload.middleware');

describe('isAudioBuffer', () => {
  test('accepts MP3 with ID3 tag', () => {
    const buf = Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ]);
    expect(isAudioBuffer(buf)).toBe(true);
  });

  test('accepts MP3 with MPEG frame sync', () => {
    const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(isAudioBuffer(buf)).toBe(true);
  });

  test('accepts WAV (RIFF...WAVE)', () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ]);
    expect(isAudioBuffer(buf)).toBe(true);
  });

  test('accepts OGG (OggS)', () => {
    const buf = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(isAudioBuffer(buf)).toBe(true);
  });

  test('accepts WebM (EBML header)', () => {
    const buf = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(isAudioBuffer(buf)).toBe(true);
  });

  test('accepts M4A (ftyp at offset 4)', () => {
    const buf = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      0x4d, 0x34, 0x41, 0x20,
    ]);
    expect(isAudioBuffer(buf)).toBe(true);
  });

  test('rejects plain text', () => {
    expect(isAudioBuffer(Buffer.from('hello world this is text'))).toBe(false);
  });

  test('rejects PE executable header (MZ)', () => {
    const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
    expect(isAudioBuffer(buf)).toBe(false);
  });

  test('rejects too-short buffer', () => {
    expect(isAudioBuffer(Buffer.from([0xff, 0xfb]))).toBe(false);
  });

  test('rejects null/undefined', () => {
    expect(isAudioBuffer(null)).toBe(false);
    expect(isAudioBuffer(undefined)).toBe(false);
  });
});
