const { buildCrmEnvelope } = require('../../src/services/integrations/crm-event.service');
const {
  CRM_DEFERRED_EVENT_TYPES,
  CRM_EVENT_TYPES,
  CRM_PHASE_ONE_EVENT_TYPES,
} = require('../../src/services/integrations/crm-event.catalog');

describe('ASINU -> CRM event contract', () => {
  test('keeps the Phase 1 and deferred sets complete and unique', () => {
    expect(CRM_PHASE_ONE_EVENT_TYPES).toHaveLength(25);
    expect(CRM_DEFERRED_EVENT_TYPES).toHaveLength(10);
    expect(CRM_EVENT_TYPES).toHaveLength(35);
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
});
