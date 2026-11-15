---
name: gifts-today
description: read today fortune eligibility and opened fortune
metadata:
  asinu:
    version: 1.0.0
    group: gifts
    selector:
      type: app_tool
      tool: gifts.today
    context:
      medication: false
      profile: false
---

# Purpose
read today fortune eligibility and opened fortune.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Read versus opening matches request. Opening requires explicit box1..6, no random choice/guessed eligibility/new rewards/silent redemption. Existing eligibility and confirmation apply.

# Example
User: Hôm nay có lộc chưa?
Expected capability: {"type":"app_tool","tool":"gifts.today"}
