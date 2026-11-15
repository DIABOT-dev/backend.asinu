---
name: set-language
description: Change app language vi/en
metadata:
  asinu:
    version: 1.0.0
    group: settings
    selector:
      type: language
    context:
      medication: false
      profile: false
---

# Purpose
Change app language vi/en.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Set only requested vi/en language. Ask if unsupported/missing. Do not infer from current settings. Existing settings UI persists change after confirmation.

# Example
User: Đổi ngôn ngữ ứng dụng sang tiếng Anh
Expected capability: {"type":"language"}
