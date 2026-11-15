---
name: set-medication-purpose
description: Choose or remove purpose tags for an existing medicine
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: app_tool
      tool: medication.purpose
    context:
      medication: false
      profile: false
---

Use target medicine and mode add/remove/set/clear. Add preserves other selected tags; set replaces the selection; remove removes only named tags; clear requires an explicit request to remove all tags. Tags must match the requested human meaning and manufacturer source. Unknown or unverified purposes require clarification, never guessing.
