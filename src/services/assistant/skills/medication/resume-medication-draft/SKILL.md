---
name: resume-medication-draft
description: Continue a selected medication draft
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: app_tool
      tool: medication.draft_resume
    context:
      medication: false
      profile: false
---

Target is the user-given medicine name, position or latest. If several drafts match, ask which. Open setup for the selected draft only; never save or submit it automatically.
