---
name: family-remove
description: disconnect selected relative identified by name
metadata:
  asinu:
    version: 1.0.0
    group: family
    selector:
      type: app_tool
      tool: family.remove
    context:
      medication: false
      profile: false
---

# Purpose
disconnect selected relative identified by name.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Exact target/phone/label/boolean/consent direction. Sharing MY health cannot grant theirs; invitations grant no health access. Only outgoing can_receive_alerts/can_ack_escalation. Received accept/reject differ from sent cancel. No invented family member or modifying another's records. Server verifies ownership/consent.

# Example
User: Ngắt kết nối với Người Thử
Expected capability: {"type":"app_tool","tool":"family.remove"}
