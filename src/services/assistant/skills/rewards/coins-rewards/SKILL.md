---
name: coins-rewards
description: list redeemable rewards, costs, valid greeting templates and
  connected recipients
metadata:
  asinu:
    version: 1.0.0
    group: rewards
    selector:
      type: app_tool
      tool: coins.rewards
    context:
      medication: false
      profile: false
---

# Purpose
list redeemable rewards, costs, valid greeting templates and connected recipients.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Read versus redemption matches words. Card needs explicit recipient/template; ticket is DRAW_TICKET. No guessed reward, manual mission completion, fabricated balance/cash conversion. Server checks balance/catalog and confirms writes. Fortune opening belongs to gifts.

# Example
User: Tôi đổi xu được những phần thưởng nào?
Expected capability: {"type":"app_tool","tool":"coins.rewards"}
