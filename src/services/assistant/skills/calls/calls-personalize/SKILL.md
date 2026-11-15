---
name: calls-personalize
description: set preferred address (bac/co/chu/anh/chi/ban/auto), use_name,
  use_health, weather_enabled or named city; never guess region
metadata:
  asinu:
    version: 1.0.0
    group: calls
    selector:
      type: app_tool
      tool: calls.personalize
    context:
      medication: false
      profile: false
---

# Purpose
set preferred address (bac/co/chu/anh/chi/ban/auto), use_name, use_health, weather_enabled or named city; never guess region.

# Procedure
1. Retain the current user request and all explicit qualifiers.
2. Prepare only this skill's declared capability; ask for missing details.
3. Return a preview through the existing backend checks and confirmation flow.

# Rules
Call patches flat, only requested exact fields/clocks/minutes/city/address. No guessed locale/GPS or context-based changes. Device weather uses native location flow. Distinguish medicine/routine/call times. Personalization does not place a call.
address is a form of address, NOT a postal address: bác=bac,cô=co,chú=chu,anh=anh,chị=chi,bạn=ban,tự động=auto. "Từ giờ xưng hô với tôi là chú" explicitly authorizes calls.personalize parameters:{address:"chu"}; no city, phone or use_name field is required or implied.

# Example
User: Từ giờ xưng hô với tôi là chú
Expected capability: {"type":"app_tool","tool":"calls.personalize"}

Weather without a previously specified city requires asking for the city; never enable city-based weather by guessing a region. Current-device weather uses the separate calls-weather-device skill and native location flow.
