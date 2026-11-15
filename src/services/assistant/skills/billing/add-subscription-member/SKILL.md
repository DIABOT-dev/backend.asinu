---
name: add-subscription-member
description: Add a connected relative to this account care plan
metadata:
  asinu:
    version: 1.0.0
    group: billing
    selector:
      type: app_tool
      tool: subscription.member_add
    context:
      medication: false
      profile: false
---

Require an explicitly named relative and confirmation. Target means a name or list position, never an ID. Only the owner of an active paid plan can add members. Never buy a plan, replace another protected member, share health records or disconnect a relative. If full, ask the user to free a place first.
