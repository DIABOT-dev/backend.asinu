---
name: log-meal
description: Log a meal description
metadata:
  asinu:
    version: 1.0.0
    group: journal
    selector:
      type: meal
    context:
      medication: false
      profile: false
---

# Purpose
Log a meal description.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Record the exact meal-description substring from this person. Never estimate nutrition; calories/carbs/protein/fat require explicit numbers. A meal question or another person is not permission. Confirm before saving.
