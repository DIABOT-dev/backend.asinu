---
name: medication-history
description: read actual recent dose outcomes, optional exact medicine name
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: app_tool
      tool: medication.history
    context:
      medication: true
      profile: false
---

# Purpose
read actual recent dose outcomes, optional exact medicine name.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Navigation opens only medication reminders when requested, without creating a reminder.
Medication: exact name from user, explicit daily frequency and unambiguous clocks for creation, all minutes/periods/corrections retained. Dose/amount, weekdays/date/end-date, as-needed, another person's drugs or prescriptions must not be discarded to create a partial plan. Moving matches medicine and original schedule in MEDICATION_CONTEXT and keeps others; its existing daily frequency may be retained. State/answer affects the whole selected group only if all were named or explicitly included; answer must match an unambiguous due dose with canAnswer=true. Do not guess medicine from a disease. Only explicitly requested rename/note/meal-anchor values. This is reminder administration, never clinical advice. Ready is only a preview.

# Example
User: Xem lịch sử uống thuốc Hapacol
Expected capability: {"type":"app_tool","tool":"medication.history"}
