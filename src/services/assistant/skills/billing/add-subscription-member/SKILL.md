---
name: add-subscription-member
description: Add a connected relative to this account care plan
metadata:
  asinu:
    version: 1.0.1
    group: billing
    selector:
      type: app_tool
      tool: subscription.member_add
    context:
      medication: false
      profile: false
---

An explicit request naming the relative is enough to PREPARE this preview. Target means a name or list position, never an ID. Reviewing the preview happens BEFORE the user confirms it: missing final confirmation is not a reason to reject a correctly requested preview. The backend checks the account's ownership, active paid plan, existing family connection and available place when preparing/applying; these database facts need not be stated in the user message. Never assume they are satisfied or bypass those checks. Only the owner of an active paid plan may apply the confirmed change. Never buy a plan, replace another protected member, share health records or disconnect a relative. If the backend finds the plan full, ask the user to free a place first.
