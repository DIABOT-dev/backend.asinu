---
name: family-list
description: list connected relatives and directional health-sharing rights
metadata:
  asinu:
    version: 1.0.0
    group: family
    selector:
      type: app_tool
      tool: family.list
    context:
      medication: false
      profile: false
---

# Purpose
list connected relatives and directional health-sharing rights.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Exact target/phone/label/boolean/consent direction. Sharing MY health cannot grant theirs; invitations grant no health access. Only outgoing can_receive_alerts/can_ack_escalation. Received accept/reject differ from sent cancel. No invented family member or modifying another's records. Server verifies ownership/consent.

# Example
User: Ai đang kết nối với tôi?
Expected capability: {"type":"app_tool","tool":"family.list"}
