---
name: read-profile-logs
description: Read actual profile records
metadata:
  asinu:
    version: 1.0.0
    group: profile
    selector:
      type: query
      topic: profile
    context:
      medication: false
      profile: true
---

# Purpose
Read actual profile records.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Queries read saved records, never create entries or invent an answer. week/month=last7/30days; this_week/month=calendar periods; custom inclusive max366days and both ISO dates. Use TODAY for relative dates. Requested statistic must match: list/latest/average/min/max; water returns recorded total. Profile/reminder/medication queries read current state only, not historical snapshots.
