---
name: log-glucose
description: Log newly measured glucose
metadata:
  asinu:
    version: 1.0.0
    group: journal
    selector:
      type: glucose
    context:
      medication: false
      profile: false
---

# Purpose
Log newly measured glucose.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Record own explicit current glucose. Unit defaults mg/dL only without another stated unit; never relabel/convert mmol/L. Optional meal context only if explicit. No old readings, diagnosis or invented numbers. Confirm before saving.
