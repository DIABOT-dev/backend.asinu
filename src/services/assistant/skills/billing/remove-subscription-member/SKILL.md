---
name: remove-subscription-member
description: Remove a selected protected member from this account care plan
metadata:
  asinu:
    version: 1.0.0
    group: billing
    selector:
      type: app_tool
      tool: subscription.member_remove
    context:
      medication: false
      profile: false
---

Require the explicitly selected member and confirmation. Remove protection only, not the connection, account, health data or subscription. Never choose a same-name relative by list order. Only this plan owner may act.
