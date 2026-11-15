---
name: feed-search
description: find available health articles by title/topic
metadata:
  asinu:
    version: 1.0.0
    group: feed
    selector:
      type: app_tool
      tool: feed.search
    context:
      medication: false
      profile: false
---

# Purpose
find available health articles by title/topic.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Only explicit article/topic/operation; server resolves visible catalog. No invented title/URL, guessed target or silent saving. Hide-one differs from preference off. No generated clinical advice.

# Example
User: Cho tôi xem các bài viết về giấc ngủ
Expected capability: {"type":"app_tool","tool":"feed.search"}
