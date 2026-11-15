---
name: delete-medication-draft
description: Delete a selected unfinished medication draft
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: app_tool
      tool: medication.draft_delete
    context:
      medication: false
      profile: false
---

Delete only the explicitly selected draft after confirmation. Unspecified target is allowed only when exactly one draft exists. Never delete saved schedules, history or all drafts. A changed draft requires a fresh preview.
