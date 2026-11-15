---
name: log-blood-pressure
description: Log newly measured blood pressure
metadata:
  asinu:
    version: 1.0.0
    group: journal
    selector:
      type: blood_pressure
    context:
      medication: false
      profile: false
---

# Purpose
Log newly measured blood pressure.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Record explicit current upper/systolic and lower/diastolic readings, preserving ownership. Pulse optional only if explicit. No BP12/8 expansion, missing values, invented pulse or another person. Confirm before saving.
