'use strict';

const mockRepo = {
  dismiss: jest.fn(),
  enqueueNotification: jest.fn(),
  getContent: jest.fn(),
  getContentCatalog: jest.fn(),
  getEligibleUserIds: jest.fn(),
  getNotificationTemplate: jest.fn(),
  getPendingNotificationJobs: jest.fn(),
  getUserContexts: jest.fn(),
  insertFeedItems: jest.fn(),
  listFeed: jest.fn(),
  localizeContent: jest.fn((content) => content),
  markNotificationJobDispatched: jest.fn(),
  upsertUserFlow: jest.fn(),
};
const mockSendPushNotification = jest.fn();
const mockSaveInAppNotification = jest.fn();
const mockHasReachedDailyCap = jest.fn();

jest.mock('../src/services/health_feed/repository', () => mockRepo);
jest.mock('../src/services/health_feed/config', () => ({
  DEFAULT_TIMEZONE: 'Asia/Ho_Chi_Minh',
  getTimeParts: jest.fn(() => ({ weekday: 'Fri' })),
  isHealthFeedEnabled: jest.fn(() => true),
  isWithinPushWindow: jest.fn(() => true),
  resolveTimezone: jest.fn((timezone) => timezone || 'Asia/Ho_Chi_Minh'),
}));
jest.mock('../src/services/health_feed/logic', () => ({
  FLOWS: { ALERT: 'alert', FAMILY: 'family', ONBOARDING: 'onboarding' },
  PUSHABLE_FLOWS: new Set(['alert', 'family', 'onboarding']),
  getSelfFlow: jest.fn(() => 'alert'),
  selectContentForPlan: jest.fn(() => [
    {
      flow: 'alert',
      id: 'feed-item-1',
      content_id: 'content-1',
      title: 'Health update',
      message: 'Please review',
    },
  ]),
}));
jest.mock('../src/services/notification/push.notification.service', () => ({
  sendPushNotification: (...args) => mockSendPushNotification(...args),
}));
jest.mock('../src/services/notification/notification.service', () => ({
  saveInAppNotification: (...args) => mockSaveInAppNotification(...args),
}));
jest.mock('../src/services/notification/notification.policy', () => ({
  hasReachedDailyCap: (...args) => mockHasReachedDailyCap(...args),
}));

const {
  dispatchPendingNotifications,
  runHealthFeedCycle,
} = require('../src/services/health_feed/service');

describe('Health Feed notification preference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not queue a notification when the user disabled Health Feed', async () => {
    mockRepo.getEligibleUserIds.mockResolvedValue([42]);
    mockRepo.getContentCatalog.mockResolvedValue([{}]);
    mockRepo.getUserContexts.mockResolvedValue([
      {
        id: 42,
        language_preference: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
        health_feed_enabled: false,
        reminders_enabled: true,
        feed_history: [],
        active_feed: [],
        related_patients: [],
        recent_template_ids: new Set(),
      },
    ]);
    mockRepo.insertFeedItems.mockResolvedValue([
      {
        flow: 'alert',
        id: 'feed-item-1',
        content_id: 'content-1',
        title: 'Health update',
        message: 'Please review',
      },
    ]);

    await expect(runHealthFeedCycle({})).resolves.toMatchObject({ queued: 0 });
    expect(mockRepo.enqueueNotification).not.toHaveBeenCalled();
  });

  test('discards a pending job without creating in-app or push notifications', async () => {
    mockRepo.getPendingNotificationJobs.mockResolvedValue([
      {
        id: 9,
        user_id: 42,
        health_feed_enabled: false,
        reminders_enabled: true,
        payload: {},
      },
    ]);

    await expect(dispatchPendingNotifications({})).resolves.toEqual({
      enabled: true,
      scanned: 1,
      sent: 0,
      skipped: 1,
    });
    expect(mockRepo.markNotificationJobDispatched).toHaveBeenCalledWith(
      {},
      9,
      'skipped_feed_disabled'
    );
    expect(mockSaveInAppNotification).not.toHaveBeenCalled();
    expect(mockSendPushNotification).not.toHaveBeenCalled();
  });
});
