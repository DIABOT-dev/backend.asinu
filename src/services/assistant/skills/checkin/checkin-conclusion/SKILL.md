---
name: checkin-conclusion
description: read full existing check-in conclusion/advice, optional ISO date;
  speak=true only if asked to listen/read aloud
metadata:
  asinu:
    version: 1.0.0
    group: checkin
    selector:
      type: app_tool
      tool: checkin.conclusion
    context:
      medication: false
      profile: false
---

# Purpose
read full existing check-in conclusion/advice, optional ISO date; speak=true only if asked to listen/read aloud.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Only saved results. Latest conclusion has no invented TODAY filter; explicit dates and speak match words. Cancel only explicitly requested unfinished check-in. Navigation never submits answers. No new advice, history deletion or clinical follow-up changes.

# Example
User: Cho tôi xem lại kết luận check-in gần nhất
Expected capability: {"type":"app_tool","tool":"checkin.conclusion"}
