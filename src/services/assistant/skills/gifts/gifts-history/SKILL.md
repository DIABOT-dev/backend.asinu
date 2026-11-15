---
name: gifts-history
description: read opened fortunes and tickets
metadata:
  asinu:
    version: 1.0.0
    group: gifts
    selector:
      type: app_tool
      tool: gifts.history
    context:
      medication: false
      profile: false
---

# Purpose
read opened fortunes and tickets.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Read versus opening matches request. Opening requires explicit box1..6, no random choice/guessed eligibility/new rewards/silent redemption. Existing eligibility and confirmation apply.

# Example
User: Cho xem lịch sử mở lộc
Expected capability: {"type":"app_tool","tool":"gifts.history"}
