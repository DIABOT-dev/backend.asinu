---
name: device-permission
description: request or open system settings for a specific device permission;
  OS still requires the person choice
metadata:
  asinu:
    version: 1.0.0
    group: settings
    selector:
      type: app_tool
      tool: device.permission
    context:
      medication: false
      profile: false
---

# Purpose
request or open system settings for a specific device permission; OS still requires the person choice.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Exact vi/en and requested font target/direction/current scale. App task/feed preferences differ from OS permission, AI consent and medicine schedules. Permission kind/boolean must match; native OS still asks. No silently granted permission.

# Example
User: Mở cấp quyền camera cho tôi
Expected capability: {"type":"app_tool","tool":"device.permission"}
