---
name: profile-avatar
description: select a new profile photo with native picker
metadata:
  asinu:
    version: 1.0.0
    group: profile
    selector:
      type: app_tool
      tool: profile.avatar
    context:
      medication: false
      profile: true
---

# Purpose
select a new profile photo with native picker.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Profile values explicit and own only. Preserve unrelated conditions when adding; remove explicitly named ones or explicit clear-all. No inferred diagnosis, identity/phone/weight change or another profile. Avatar opens picker; query reads current profile.

# Example
User: Đổi ảnh đại diện giúp tôi
Expected capability: {"type":"app_tool","tool":"profile.avatar"}
