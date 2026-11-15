---
name: wallet-history
description: read actual wallet payment history
metadata:
  asinu:
    version: 1.0.0
    group: billing
    selector:
      type: app_tool
      tool: wallet.history
    context:
      medication: false
      profile: false
---

# Purpose
read actual wallet payment history.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Reads never authorize payment. Topup only prefills explicit VND amount with correct magnitude. Upgrade only opens checkout, explicit plan/billing only. No charged payment/transfers/guessed duration/entitlements or bypass.

# Example
User: Cho xem lịch sử thanh toán trong ví của tôi
Expected capability: {"type":"app_tool","tool":"wallet.history"}
