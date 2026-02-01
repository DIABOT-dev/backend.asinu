/**
 * Models Index
 * Central export for all database models
 */

// User and Authentication
const UserModel = require('./user.model');

// Health Logs
const LogsModel = require('./logs.model');

// Care Circle
const CareCircleModel = require('./care-circle.model');

// Missions
const MissionsModel = require('./missions.model');

// Wellness Monitoring
const WellnessModel = require('./wellness.model');

// Chat
const ChatModel = require('./chat.model');

// Onboarding
const OnboardingModel = require('./onboarding.model');

// Care Pulse
const CarePulseModel = require('./care-pulse.model');

module.exports = {
  User: UserModel,
  Logs: LogsModel,
  CareCircle: CareCircleModel,
  Missions: MissionsModel,
  Wellness: WellnessModel,
  Chat: ChatModel,
  Onboarding: OnboardingModel,
  CarePulse: CarePulseModel
};
