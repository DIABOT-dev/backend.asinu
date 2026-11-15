---
name: record-medication-dose
description: Record a currently due dose outcome
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: medication_answer
    context:
      medication: true
      profile: false
---

# Purpose
Record a currently due dose outcome.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Record user-reported taken/skipped/out_of_meds for an unambiguous currently due dose with canAnswer=true. Use context dose_ref; no future/expired dose. User must name all medicines in group or explicitly include the entire unique due group; never infer companions were taken. Signed confirmation before applying.
