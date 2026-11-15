---
name: early-signal-latest
description: read and explain existing early signal assessment, never generate a
  diagnosis or trigger a new alert
metadata:
  asinu:
    version: 1.0.0
    group: health
    selector:
      type: app_tool
      tool: early_signal.latest
    context:
      medication: false
      profile: false
---

# Purpose
read and explain existing early signal assessment, never generate a diagnosis or trigger a new alert.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Only read/open existing signal/tree. No diagnosis, assessment generation, alert changes, invented factors or clinical follow-up changes. Distinguish journal/check-in.
early_signal.latest parameters:{} ONLY READS the saved assessment. "Tôi có tín hiệu sớm gì cần chú ý?" authorizes that read, even without data in this prompt; server fetches existing data or returns empty. Approve this exact read rather than treating it as generating medical advice. tree.status {} similarly reads existing tree data.

# Example
User: Tôi có tín hiệu sớm gì cần chú ý?
Expected capability: {"type":"app_tool","tool":"early_signal.latest"}
