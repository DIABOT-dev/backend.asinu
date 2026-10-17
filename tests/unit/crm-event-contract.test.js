const { buildCrmEnvelope } = require('../../src/services/integrations/crm-event.service');
const {
  CRM_DEFERRED_EVENT_TYPES,
  CRM_EVENT_TYPES,
  CRM_PHASE_ONE_EVENT_TYPES,
} = require('../../src/services/integrations/crm-event.catalog');

describe('ASINU -> CRM event contract', () => {
  test('keeps the Phase 1 and deferred sets complete and unique', () => {
    expect(CRM_PHASE_ONE_EVENT_TYPES).toHaveLength(37);
    expect(CRM_DEFERRED_EVENT_TYPES).toHaveLength(4);
    expect(CRM_EVENT_TYPES).toHaveLength(41);
    expect(new Set(CRM_EVENT_TYPES).size).toBe(CRM_EVENT_TYPES.length);
  });

  test('builds a valid envelope for a catalogued event', () => {
    const envelope = buildCrmEnvelope(
      'profile.updated',
      { user_id: '1' },
      {
        event_id: 'profile.updated:1:2026-07-23T00:00:00.000Z',
      }
    );
    expect(envelope).toMatchObject({
      event_id: 'profile.updated:1:2026-07-23T00:00:00.000Z',
      event_type: 'profile.updated',
      source: 'asinu-backend',
      version: 1,
      payload: { user_id: '1' },
    });
  });

  test('rejects event types outside the approved contract', () => {
    expect(() => buildCrmEnvelope('service.completed', {})).not.toThrow();
    expect(() => buildCrmEnvelope('crm.typo', {})).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CRM_EVENT_TYPE' })
    );
  });
  test('gift events keep identifiers and coarse answers without forwarding contact, clinical text or offer codes', () => {
    const { projectCrmPayload } = require('../../src/services/integrations/crm-event.policy');
    expect(
      projectCrmPayload('gift.opened', {
        user_id: '1',
        household_id: '2',
        gift_event_id: 'gift-1',
        loc_id: '3',
        extra: 'none',
        answer: 'tired',
        date_vn: '2026-10-17',
        phone_number: 'private',
        email: 'private',
        transcript: 'private',
        medical_conditions: ['private'],
        store_code: 'private',
        loc_text: 'private',
      })
    ).toEqual({
      user_id: '1',
      household_id: '2',
      gift_event_id: 'gift-1',
      loc_id: '3',
      extra: 'none',
      answer: 'tired',
      date_vn: '2026-10-17',
    });
    expect(
      projectCrmPayload('ticket.issued', {
        user_id: '1',
        ticket_no: 'A1',
        draw_period: '2026-10',
        phone_number: 'private',
      })
    ).toEqual({ user_id: '1', ticket_no: 'A1', draw_period: '2026-10' });
  });
});
