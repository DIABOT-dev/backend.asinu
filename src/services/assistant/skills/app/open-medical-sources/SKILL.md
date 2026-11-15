---
name: open-medical-sources
description: Open existing medical sources screen
metadata:
  asinu:
    version: 1.0.0
    group: app
    selector:
      type: navigate
      destination: medical_sources
    context:
      medication: false
      profile: false
---

# Purpose
Open existing medical sources screen.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Open only the explicitly requested existing screen. Navigation never submits data, answers a check-in, contacts a person, purchases, grants permission or executes actions on that screen.
