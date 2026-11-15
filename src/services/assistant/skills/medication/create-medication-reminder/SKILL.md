---
name: create-medication-reminder
description: Create a named daily medicine or supplement reminder
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: medication_create
    context:
      medication: true
      profile: false
---

# Purpose
Create a named daily medicine or supplement reminder.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Create this account medication or supplement reminder only. Preserve kind: MEDICINE for medicines, SUPPLEMENT for an explicitly requested vitamin or dietary supplement. If the product category is unclear, ask; never infer it from a disease. Do not attach medicine-purpose tags to supplements. Need exact user-given medicine name, 1-4 explicit unambiguous clocks and DAILY repetition. Missing name first, then time/frequency. Do not silently discard dose/amount/weekday/end-date/as-needed/other-owner qualifiers. Do not infer drug from disease. 7am=07:00,7pm=19:00,7:30pm=19:30; unqualified7 needs period. Existing matching reminders may require add-vs-move clarification. purpose_codes is optional: omit to suggest all verified tags, include only user-selected purpose codes, or [] only when the user explicitly requests no tags. Never infer a tag from symptoms or a disease. Existing saved-medicine tag edits use set-medication-purpose separately. No prescriptions; signed preview and user confirmation before saving.

# Example
User: Nhờ Asinu nhắc uống Hapacol hằng ngày, vào 7 giờ rưỡi sáng
Expected capability: {"type":"medication_create"}
