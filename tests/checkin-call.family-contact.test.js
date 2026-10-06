'use strict';

const { familyContact, familyNotice, relationshipForRecipient } = require('../src/services/checkin-call/family-contact.service');
const service = require('../src/services/checkin-call/checkin-call.service');

describe('family call identity and relationship direction', () => {
  test.each([
    ['me', true, null, 'vi', 'Mẹ của bạn'],
    ['Mẹ', true, null, 'en', 'Your mother'],
    ['Mother', true, null, 'vi', 'Mẹ của bạn'],
    ['bo', false, 'Nữ', 'vi', 'Con gái của bạn'],
    ['Mẹ', false, 'Nam', 'vi', 'Con trai của bạn'],
    ['mother', false, null, 'en', 'Your child'],
    ['con-gai', false, 'Nữ', 'vi', 'Mẹ của bạn'],
    ['Son', false, 'male', 'en', 'Your father'],
    ['con-trai', false, null, 'vi', 'Bố hoặc mẹ của bạn'],
    ['anh-trai', false, 'female', 'vi', 'Em gái của bạn'],
    ['em-gai', false, 'Nam', 'vi', 'Anh trai của bạn'],
    ['chi-gai', false, null, 'en', 'Your younger sibling'],
    ['Vợ', false, null, 'vi', 'Chồng của bạn'],
    ['Husband', false, null, 'en', 'Your wife'],
    ['Ông nội', true, null, 'en', 'Your paternal grandfather'],
    ['ba-ngoai', false, 'Nữ', 'vi', 'Cháu gái của bạn'],
    ['granddaughter', false, 'male', 'en', 'Your grandfather'],
    ['Bạn thân', false, null, 'en', 'Your close friend'],
    ['Người yêu', false, null, 'vi', 'Người yêu của bạn'],
    ['Người thân', true, null, 'vi', 'Người thân của bạn'],
    [null, false, null, 'en', 'Your family member'],
    ['Dì', true, null, 'vi', 'Dì của bạn'],
    ['Dì', false, null, 'vi', 'Người thân của bạn'],
  ])('%s direction requester=%s gender=%s in %s', (type, forward, gender, lang, expected) => {
    expect(relationshipForRecipient(type, forward, gender, lang)).toBe(expected);
  });

  test('contact contains the protected person, not the alert recipient', () => {
    const subject = familyContact({
      subject_name: '  Nguyễn Thị Lan  ', subject_phone: '0901234567',
      relationship_type: 'me', relationship_requester_id: 7,
    }, 7, 'vi');
    expect(subject).toEqual({ name: 'Nguyễn Thị Lan', relationship: 'Mẹ của bạn', phone_number: '0901234567' });
    expect(familyContact({}, 7, 'en')).toEqual({
      name: 'The person to check on', relationship: 'Your family member', phone_number: null,
    });
  });

  test.each(['UNKNOWN', 'MILD', 'URGENT'])('%s voice names the relationship and reads each phone digit', severity => {
    const subject = { name: 'Nguyễn Thị Lan', relationship: 'Mẹ của bạn', phone_number: '0901234567' };
    const notice = familyNotice({ severity, triage_display: { summary: 'Đầu · Chóng mặt · Nhẹ' } }, subject, 'vi');
    expect(notice.message).toContain(subject.name);
    expect(notice.audio_text).toContain(subject.name);
    expect(notice.audio_text).toContain(subject.relationship);
    expect(notice.audio_text).toContain('0 9 0 1 2 3 4 5 6 7');
    expect(notice.audio_text).toContain('Tôi nhận, sẽ kiểm tra');
    expect(notice.audio_text).not.toContain('{{');
    if (severity !== 'UNKNOWN') expect(notice.audio_text).toContain('Đầu · Chóng mặt · Nhẹ');
  });

  test('English and missing contact fields have honest localized fallbacks', () => {
    const notice = familyNotice({ severity: 'UNKNOWN' }, {
      name: 'Lan', relationship: 'Your mother', phone_number: null,
    }, 'en');
    expect(notice.audio_text).toContain('Lan, Your mother');
    expect(notice.audio_text).toContain('No contact phone number');
    expect(notice.audio_text).not.toMatch(/undefined|null|\{\{/);
  });

  function attemptPool(role = 'FAMILY') {
    return { query: jest.fn(async (sql, params) => {
      // Model the SQL's recipient predicate without bypassing the real service.
      expect(sql).toContain('a.target_user_id = $2');
      expect(sql).toContain("status = 'accepted'");
      if (params[1] !== 7) return { rows: [] };
      return { rows: [{
        id: 'attempt-1', target_role: role, severity: 'UNKNOWN', triage_context: {},
        subject_name: 'Lan', subject_phone: '0901234567', subject_gender: 'Nữ',
        relationship_type: 'con-trai', relationship_requester_id: 9,
      }] };
    }) };
  }

  test('authorized family gets correct reverse relationship and no raw join columns', async () => {
    const attempt = await service.getAttempt(attemptPool(), 'attempt-1', 7, 'vi');
    expect(attempt.subject).toMatchObject({ name: 'Lan', relationship: 'Mẹ của bạn', phone_number: '0901234567' });
    for (const key of ['subject_name', 'subject_phone', 'subject_gender', 'relationship_type', 'relationship_requester_id']) {
      expect(attempt).not.toHaveProperty(key);
    }
    expect(attempt.triage_context).toBeNull();
    expect(await service.getAttempt(attemptPool(), 'attempt-1', 999, 'vi')).toBeNull();
  });

  test('user attempts do not receive family-only metadata', async () => {
    const attempt = await service.getAttempt(attemptPool('USER'), 'attempt-1', 7);
    expect(attempt).not.toHaveProperty('subject');
    expect(attempt).not.toHaveProperty('family_notice');
  });

  test('wrong account and USER role cannot request personalized family speech', async () => {
    await expect(service.getFamilyAudio(attemptPool(), 'attempt-1', 999)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getFamilyAudio(attemptPool('USER'), 'attempt-1', 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('personalized family speech uses the private Tuấn Anh v4 clone with server-authorized identity', async () => {
    const previousKey = process.env.VIENEU_API_KEY;
    const previousVoice = process.env.VIENEU_VOICE;
    const previousFetch = global.fetch;
    process.env.VIENEU_API_KEY = 'test-key';
    const voice = 'clone_b935a451-7d65-4b73-a083-d46e56c47d4f';
    process.env.VIENEU_VOICE = voice;
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        status: 'completed', voiceId: voice, audioUrl: 'https://storage.vieneu.io/family.wav',
      }) })
      .mockResolvedValueOnce({ ok: true, headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => Buffer.from('personalized-family-audio') });
    try {
      const result = await service.getFamilyAudio(attemptPool(), 'attempt-1', 7, 'vi');
      expect(result.audio_data.toString()).toBe('personalized-family-audio');
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.voiceId).toBe(voice);
      expect(body.engine).toBe('v4');
      expect(body.text).toContain('Lan, Mẹ của bạn');
      expect(body.text).toContain('0 9 0 1 2 3 4 5 6 7');
    } finally {
      if (previousKey === undefined) delete process.env.VIENEU_API_KEY;
      else process.env.VIENEU_API_KEY = previousKey;
      if (previousVoice === undefined) delete process.env.VIENEU_VOICE;
      else process.env.VIENEU_VOICE = previousVoice;
      global.fetch = previousFetch;
    }
  });
});
