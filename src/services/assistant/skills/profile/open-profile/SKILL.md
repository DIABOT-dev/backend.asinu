---
name: open-profile
description: Open existing profile screen
metadata:
  asinu:
    version: 1.0.0
    group: profile
    selector:
      type: navigate
      destination: profile
    context:
      medication: false
      profile: true
---

# Purpose
Open existing profile screen.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Open only the explicitly requested existing screen. Navigation never submits data, answers a check-in, contacts a person, purchases, grants permission or executes actions on that screen.
