---
name: set-font-size
description: Change app font size
metadata:
  asinu:
    version: 1.0.0
    group: settings
    selector:
      type: font_size
    context:
      medication: false
      profile: false
---

# Purpose
Change app font size.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Match actual app font: small=Nhỏ,normal=Bình thường,large=Lớn,xlarge=Rất lớn. increase/decrease one step from INPUT.current.fontSize, not an arbitrary jump. Explicit target/direction required. Confirm before changing.

# Example
User: Tăng cỡ chữ lên một mức
Expected capability: {"type":"font_size"}
