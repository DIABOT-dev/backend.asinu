---
name: subscription-members
description: List people protected by the care plan owned by this account
metadata:
  asinu:
    version: 1.0.0
    group: billing
    selector:
      type: app_tool
      tool: subscription.members
    context:
      medication: false
      profile: false
---

Read only this account own plan. A connected relative is not necessarily a protected member. Never create a household or change membership during a read.
