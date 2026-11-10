'use strict';

jest.mock('../../src/services/checkin-call/audio.service', () => ({
  MAX_DYNAMIC_TEXT_LENGTH: 1600,
  normalizeLanguage: (value) => (String(value).startsWith('en') ? 'en' : 'vi'),
  audioVersion: jest.fn(() => 'voice-v1'),
  synthesizeText: jest.fn(),
}));
jest.mock('../../src/services/voice/mp3.service', () => ({
  encodeMp3: jest.fn(async (data) => ({ audio_data: data, mime_type: 'audio/mpeg' })),
  concatenateMp3: jest.fn(async (parts) => ({
    audio_data: Buffer.concat(parts),
    mime_type: 'audio/mpeg',
  })),
}));

let audio, service, codec;
const recording = {
  audio_data: Buffer.from('speech'),
  mime_type: 'audio/mpeg',
  audio_version: 'voice-v1',
};

beforeEach(() => {
  jest.resetModules();
  audio = require('../../src/services/checkin-call/audio.service');
  service = require('../../src/services/checkin-call/conclusion-audio.service');
  codec = require('../../src/services/voice/mp3.service');
  audio.synthesizeText.mockResolvedValue(recording);
});

test('identical statements in summary/advice are read once without rewriting unique instructions', () => {
  expect(
    service.conclusionText(
      'Kết luận: Bạn nên đi khám hôm nay. Lời khuyên: Bạn nên đi khám hôm nay. Nếu triệu chứng nặng lên, hãy đi cấp cứu ngay.'
    )
  ).toBe('Kết luận: Bạn nên đi khám hôm nay. Nếu triệu chứng nặng lên, hãy đi cấp cứu ngay.');
});

test('decimals, distinct instructions and natural repeated words are preserved verbatim', () => {
  const text =
    'Đường huyết 6.4 mmol/L. Hít thở đều đều. Đi khám hôm nay. Nếu đau tăng, đi khám ngay.';
  expect(service.conclusionText(text)).toBe(text);
  const en =
    'Glucose is 6.4 mmol/L. Contact a specialist today. If symptoms worsen, seek urgent care.';
  expect(service.conclusionText(en, 'en')).toBe(en);
});

test('oversized input is not shortened to bypass synthesis validation', async () => {
  const text = 'Câu nói được lặp lại. '.repeat(2000).trim();
  expect(service.conclusionText(text)).toBe(text);
  await expect(service.getConclusionAudio(7, text)).rejects.toMatchObject({ statusCode: 400 });
  expect(audio.synthesizeText).not.toHaveBeenCalled();
});

test('concurrent identical requests and replay share one recording for the authenticated recipient', async () => {
  const results = await Promise.all([
    service.getConclusionAudio(7, 'Bạn nên đi khám hôm nay.'),
    service.getConclusionAudio(7, 'Bạn nên đi khám hôm nay.'),
  ]);
  expect(results[0]).toBe(results[1]);
  expect(await service.getConclusionAudio(7, 'Bạn nên đi khám hôm nay.')).toBe(results[0]);
  expect(audio.synthesizeText).toHaveBeenCalledTimes(1);
});

test('recipient, language, transcript and voice revision isolate cache entries', async () => {
  await service.getConclusionAudio(7, 'Kết quả đã ghi nhận.');
  await service.getConclusionAudio(8, 'Kết quả đã ghi nhận.');
  await service.getConclusionAudio(7, 'Kết quả đã ghi nhận.', 'en');
  await service.getConclusionAudio(7, 'Kết quả đã thay đổi.');
  audio.audioVersion.mockReturnValue('voice-v2');
  audio.synthesizeText.mockResolvedValue({ ...recording, audio_version: 'voice-v2' });
  await service.getConclusionAudio(7, 'Kết quả đã ghi nhận.');
  expect(audio.synthesizeText).toHaveBeenCalledTimes(5);
});

test('failed requests are not cached and a replay can retry', async () => {
  audio.synthesizeText.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(service.getConclusionAudio(7, 'Xin chào.')).rejects.toThrow('provider unavailable');
  await expect(service.getConclusionAudio(7, 'Xin chào.')).resolves.toEqual(recording);
  expect(audio.synthesizeText).toHaveBeenCalledTimes(2);
});

const longTranscript = (prefix) =>
  Array.from(
    { length: 125 },
    (_, index) =>
      `${prefix} đoạn ${index}: Mình ghi lại thay đổi trong sinh hoạt để theo dõi đầy đủ.`
  ).join(' ');

test.each(['vi', 'en'])(
  'long %s conclusions synthesize every word in bounded segments and preserve final advice',
  async (language) => {
    const text = longTranscript('Nội dung') + ' Lời khuyên cuối: hãy giữ lại kết quả đã ghi.';
    const normalized = service.conclusionText(text, language);
    const chunks = service.splitConclusionText(normalized, language);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.length <= audio.MAX_DYNAMIC_TEXT_LENGTH)).toBe(true);
    expect(chunks.join(' ')).toBe(normalized);
    audio.synthesizeText.mockImplementation(async (part) => ({
      ...recording,
      audio_data: Buffer.from(part + ' '),
    }));
    const result = await service.getConclusionAudio(7, text, language);
    expect(result.audio_data.toString().trim()).toBe(normalized);
    expect(result.audio_data.toString()).toContain('Lời khuyên cuối: hãy giữ lại kết quả đã ghi.');
    expect(audio.synthesizeText.mock.calls.map((call) => call[0])).toEqual(chunks);
    expect(audio.synthesizeText.mock.calls.every((call) => call[1] === language)).toBe(true);
  }
);

test('provider concurrency is bounded across users, not only within one recording', async () => {
  let active = 0,
    maximum = 0;
  audio.synthesizeText.mockImplementation(async (part) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { ...recording, audio_data: Buffer.from(part + ' ') };
  });
  const results = await Promise.all([
    service.getConclusionAudio(7, longTranscript('Người thứ nhất')),
    service.getConclusionAudio(8, longTranscript('Người thứ hai')),
  ]);
  expect(maximum).toBeLessThanOrEqual(3);
  expect(results[0].audio_data.toString().trim()).toBe(
    service.conclusionText(longTranscript('Người thứ nhất'))
  );
  expect(results[1].audio_data.toString().trim()).toBe(
    service.conclusionText(longTranscript('Người thứ hai'))
  );
});

test('a failed segment never returns a partial recording and replay retries the complete text', async () => {
  const text = longTranscript('Thử lại');
  let calls = 0;
  audio.synthesizeText.mockImplementation(async (part) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (++calls === 2) throw new Error('middle synthesis failed');
    return { ...recording, audio_data: Buffer.from(part + ' ') };
  });
  await expect(service.getConclusionAudio(7, text)).rejects.toThrow('middle synthesis failed');
  expect(codec.concatenateMp3).not.toHaveBeenCalled();
  audio.synthesizeText.mockImplementation(async (part) => ({
    ...recording,
    audio_data: Buffer.from(part + ' '),
  }));
  const replay = await service.getConclusionAudio(7, text);
  expect(replay.audio_data.toString().trim()).toBe(service.conclusionText(text));
});

test('a burst has a bounded number of pending private recordings', async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  audio.synthesizeText.mockImplementation(async () => {
    await blocked;
    return recording;
  });
  const requests = Array.from({ length: 8 }, (_, index) =>
    service.getConclusionAudio(7, `Kết quả thứ ${index}.`)
  );
  await expect(service.getConclusionAudio(7, 'Kết quả thứ chín.')).rejects.toMatchObject({
    statusCode: 503,
  });
  release();
  await Promise.all(requests);
});

test('preparation can time out without failing clinical completion and finishes the replay cache', async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  audio.synthesizeText.mockImplementation(async () => {
    await blocked;
    return recording;
  });
  const result = {
    isDone: true,
    conclusionVersion: 2,
    severity: 'medium',
    speechText: 'Toàn bộ lời khuyên.',
  };
  await expect(service.prepareConclusionAudio(7, result, 'vi', 1)).resolves.toBeUndefined();
  expect(result.speechText).toBe('Toàn bộ lời khuyên.');
  release();
  await service.getConclusionAudio(7, result.speechText);
  expect(audio.synthesizeText).toHaveBeenCalledTimes(1);
});

test('a changed response revision cannot populate a cache entry for an older voice', async () => {
  audio.synthesizeText.mockResolvedValue({ ...recording, audio_version: 'voice-v2' });
  await service.getConclusionAudio(7, 'Xin chào.');
  await service.getConclusionAudio(7, 'Xin chào.');
  expect(audio.synthesizeText).toHaveBeenCalledTimes(2);
});

test('recording count is bounded even while entries have not expired', async () => {
  for (let index = 0; index < 65; index++) {
    await service.getConclusionAudio(7, 'Kết quả số ' + index + '.');
  }
  await service.getConclusionAudio(7, 'Kết quả số 0.');
  expect(audio.synthesizeText).toHaveBeenCalledTimes(66);
});

test('private recordings expire instead of remaining in the process indefinitely', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await service.getConclusionAudio(7, 'Xin chào.');
    now.mockReturnValue(1000 + 5 * 60_000);
    await service.getConclusionAudio(7, 'Xin chào.');
    expect(audio.synthesizeText).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
  }
});
