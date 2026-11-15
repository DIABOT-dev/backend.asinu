---
name: set-routine-reminders
description: Change routine reminder times
metadata:
  asinu:
    version: 1.0.0
    group: reminders
    selector:
      type: routine_reminders
    context:
      medication: false
      profile: false
---

# Purpose
Change routine reminder times.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Preserve complete routine morning/afternoon/evening time instruction as evidence, with ALL clocks/minutes/periods and final corrections. This action deliberately has no time fields: existing clock skill validates/shifts/signs them. Do not confuse medicine or check-in calls, turn wake-up habits into changes, or drop weekdays/one-off/extra reminders. Unqualified7 needs period. Confirm before saving.

# Example
User: Đổi giờ nhắc buổi tối sang 8 giờ 30 tối
Expected capability: {"type":"routine_reminders"}
