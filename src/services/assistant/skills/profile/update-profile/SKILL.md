---
name: update-profile
description: Update own explicit personal profile; heightCm is centimeters (1m70 = 170)
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
Normalize an explicitly stated height to heightCm: 170 cm, 1m70, 1 m 70 cm, 1.70 m and 1,70 mét all mean 170 cm. Preserve the stated value; never copy only the meter or centimeter component. If the height is missing or ambiguous, ask specifically for it instead of asking the person to repeat the whole action. Do not infer a height from age, weight, another person's data or a target height.

# Example
User: Đổi chiều cao của tôi thành 170 cm
Expected capability: {"type":"profile"}
User: Cập nhật chiều cao cho tôi là 1 m 70 cm
Expected arguments: {"changes":{"heightCm":170}}
