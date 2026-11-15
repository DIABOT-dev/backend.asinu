---
name: app-share
description: open native share sheet for Asinu, never silently send to someone
metadata:
  asinu:
    version: 1.0.0
    group: app
    selector:
      type: app_tool
      tool: app.share
    context:
      medication: false
      profile: false
---

# Purpose
open native share sheet for Asinu, never silently send to someone.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Only requested existing help/update/guide/share/listed screen. Share/support opens UI, never sends. Consultation navigation only, no expert communication/booking. No logout/account deletion/arbitrary URLs/invented capability.

# Example
User: Chia sẻ ứng dụng Asinu
Expected capability: {"type":"app_tool","tool":"app.share"}
