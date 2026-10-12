'use strict';

jest.mock('../../src/services/checkin-call/audio.service', () => ({
  MAX_DYNAMIC_TEXT_LENGTH: 1600,
  normalizeLanguage: (value) => (String(value).startsWith('en') ? 'en' : 'vi'),
  audioVersion: jest.fn(() => 'voice-v1'),
  synthesizeText: jest.fn(),
}));

let audio, service;
const recording = {
  audio_data: Buffer.from('speech'),
  mime_type: 'audio/mpeg',
  audio_version: 'voice-v1',
};

beforeEach(() => {
  jest.resetModules();
  audio = require('../../src/services/checkin-call/audio.service');
  service = require('../../src/services/checkin-call/conclusion-audio.service');
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
  const text = 'Câu nói được lặp lại. '.repeat(100).trim();
  expect(service.conclusionText(text)).toBe(text);
});

test('concurrent identical requests and replay share one recording for the authenticated recipient', async () => {
  const results = await Promise.all([
    service.getConclusionAudio(7, 'Bạn nên đi khám hôm nay.'),
    service.getConclusionAudio(7, 'Bạn nên đi khám hôm nay.'),
  ]);
  expect(results[0]).toBe(results[1]);
  expect(await service.getConclusionAudio(7, 'Bạn nên đi khám hôm nay.')).toBe(recording);
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
  await expect(service.getConclusionAudio(7, 'Xin chào.')).resolves.toBe(recording);
  expect(audio.synthesizeText).toHaveBeenCalledTimes(2);
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
