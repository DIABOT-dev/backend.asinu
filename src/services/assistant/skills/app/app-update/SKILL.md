---
name: app-update
description: check available app update using existing app update flow
metadata:
  asinu:
    version: 1.0.0
    group: app
    selector:
      type: app_tool
      tool: app.update
    context:
      medication: false
      profile: false
---

# Purpose
check available app update using existing app update flow.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Only requested existing help/update/guide/share/listed screen. Share/support opens UI, never sends. Consultation navigation only, no expert communication/booking. No logout/account deletion/arbitrary URLs/invented capability.

# Example
User: Kiểm tra cập nhật ứng dụng
Expected capability: {"type":"app_tool","tool":"app.update"}
