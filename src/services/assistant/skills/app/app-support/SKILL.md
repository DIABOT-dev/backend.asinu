---
name: app-support
description: open existing Zalo support entry; never send a message automatically
metadata:
  asinu:
    version: 1.0.0
    group: app
    selector:
      type: app_tool
      tool: app.support
    context:
      medication: false
      profile: false
---

# Purpose
open existing Zalo support entry; never send a message automatically.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Only requested existing help/update/guide/share/listed screen. Share/support opens UI, never sends. Consultation navigation only, no expert communication/booking. No logout/account deletion/arbitrary URLs/invented capability.

# Example
User: Mở hỗ trợ qua Zalo
Expected capability: {"type":"app_tool","tool":"app.support"}
