---
name: move-medication-reminder
description: Move one medicine reminder time
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: medication_move
    context:
      medication: true
      profile: false
---

# Purpose
Move one medicine reminder time.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Move ONE named medicine from ONE existing schedule using MEDICATION_CONTEXT m/s references. Preserve every other medicine and existing daily frequency. Ask when original group/add-vs-move or target clock is ambiguous; unqualified7 needs period. Preserve minutes/corrections. No guessed medicine by disease or dose change. Signed confirmation before saving.
