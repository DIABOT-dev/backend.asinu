---
name: remove-subscription-member
description: Remove a selected protected member from this account care plan
metadata:
  asinu:
    version: 1.0.1
    group: billing
    selector:
      type: app_tool
      tool: subscription.member_remove
    context:
      medication: false
      profile: false
---

An explicit request naming the member is enough to PREPARE this preview. Reviewing the preview happens BEFORE the user confirms it: missing final confirmation is not a reason to reject a correctly requested preview. The backend checks plan ownership, current membership and an unambiguous matching person when preparing/applying; these database facts need not be stated in the user message. Never assume they are satisfied or bypass those checks. Remove protection only after confirmation, not the connection, account, health data or subscription. Never choose a same-name relative by list order. Only this plan owner may apply the confirmed change.
