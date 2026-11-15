---
name: read-medication-purposes
description: Read selected and verified available medicine purpose tags
metadata:
  asinu:
    version: 1.0.0
    group: medication
    selector:
      type: app_tool
      tool: medication.purposes
    context:
      medication: false
      profile: false
---

Use the exact user-given medicine name. Report only saved or manufacturer-verified purpose tags. Do not infer indications from a condition. Supplements do not receive medicine tags.
