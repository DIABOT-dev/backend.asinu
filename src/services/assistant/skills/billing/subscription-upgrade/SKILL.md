---
name: subscription-upgrade
description: open care plan purchase flow with selected plan/billing; Store
  checkout remains explicit
metadata:
  asinu:
    version: 1.0.0
    group: billing
    selector:
      type: app_tool
      tool: subscription.upgrade
    context:
      medication: false
      profile: false
---

# Purpose
open care plan purchase flow with selected plan/billing; Store checkout remains explicit.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Reads never authorize payment. Topup only prefills explicit VND amount with correct magnitude. Upgrade only opens checkout, explicit plan/billing only. No charged payment/transfers/guessed duration/entitlements or bypass.

# Example
User: Tôi muốn mua gói An Tâm 4 theo năm
Expected capability: {"type":"app_tool","tool":"subscription.upgrade"}
