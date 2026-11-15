---
name: gifts-open
description: open today fortune box, box is user-selected one-based 1 to 6;
  never choose a box for the user
metadata:
  asinu:
    version: 1.0.0
    group: gifts
    selector:
      type: app_tool
      tool: gifts.open
    context:
      medication: false
      profile: false
---

# Purpose
open today fortune box, box is user-selected one-based 1 to 6; never choose a box for the user.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Read versus opening matches request. Opening requires explicit box1..6, no random choice/guessed eligibility/new rewards/silent redemption. Existing eligibility and confirmation apply.

# Example
User: Mở hộp lộc số 2 hôm nay
Expected capability: {"type":"app_tool","tool":"gifts.open"}
