---
name: notifications-delete-all
description: delete all currently existing visible notifications, not future notifications
metadata:
  asinu:
    version: 1.0.0
    group: notifications
    selector:
      type: app_tool
      tool: notifications.delete_all
    context:
      medication: false
      profile: false
---

# Purpose
delete all currently existing visible notifications, not future notifications.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Exact requested list/read/delete operation and scope(one/all), explicit target and unread filter only. No treating a read query as deletion/marking, no future-notification suppression or guessed target. Server checks visible owner inbox. Delivery settings require settings skill.

# Example
User: Xóa tất cả thông báo
Expected capability: {"type":"app_tool","tool":"notifications.delete_all"}
