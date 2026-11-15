---
name: manage-medication-reminder
description: Pause/resume/delete a medicine reminder group
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: medication_state
    context:
      medication: true
      profile: false
---

# Purpose
Pause/resume/delete a medicine reminder group.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Pause/resume/delete an identified WHOLE reminder group. Use context schedule_ref. If companions exist, user must name all or explicitly include all in unique named clock group; otherwise clarify. Never silently change companion medicines. Signed confirmation before applying.
