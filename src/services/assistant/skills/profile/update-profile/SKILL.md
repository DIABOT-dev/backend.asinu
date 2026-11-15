---
name: update-profile
description: Update own explicit personal profile
metadata:
  asinu:
    version: 1.0.0
    group: profile
    selector:
      type: profile
    context:
      medication: false
      profile: true
---

# Purpose
Update own explicit personal profile.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Edit own explicit name/birth date/gender/height/blood group/declared conditions only. Preserve PROFILE_CONTEXT conditions when adding; remove specifically requested ones or explicit clear-all. No inferred diagnosis/phone/identity/weight/other profile. Dates1900..TODAY,height50..250cm. Signed version-bound confirmation before saving.

# Example
User: Đổi chiều cao của tôi thành 170 cm
Expected capability: {"type":"profile"}
