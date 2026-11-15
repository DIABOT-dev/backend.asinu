---
name: feed-read
description: open or read a specific article identified by its title
metadata:
  asinu:
    version: 1.0.0
    group: feed
    selector:
      type: app_tool
      tool: feed.read
    context:
      medication: false
      profile: false
---

# Purpose
open or read a specific article identified by its title.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Only explicit article/topic/operation; server resolves visible catalog. No invented title/URL, guessed target or silent saving. Hide-one differs from preference off. No generated clinical advice.

# Example
User: Đọc bài viết Giấc ngủ tốt
Expected capability: {"type":"app_tool","tool":"feed.read"}
