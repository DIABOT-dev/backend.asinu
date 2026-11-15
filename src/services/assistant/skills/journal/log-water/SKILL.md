---
name: log-water
description: Log water just drunk
metadata:
  asinu:
    version: 1.0.0
    group: journal
    selector:
      type: water
    context:
      medication: false
      profile: false
---

# Purpose
Log water just drunk.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Record only the explicit amount of water this person just drank. Number required; ml default only when explicitly stated. Litres to ml allowed; no guessed cup size or goal/old reading/other person. New own just-drank report can request entry; a question does not. Confirm before saving.

# Example
User: Bạn ghi giúp tôi lượng nước vừa uống là 200 ml nhé
Expected capability: {"type":"water"}
