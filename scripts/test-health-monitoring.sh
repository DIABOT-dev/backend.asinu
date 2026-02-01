#!/bin/bash

# Script test real-time health monitoring system
echo "🧪 Testing Real-time Health Monitoring System"
echo "=============================================="

BACKEND_URL="http://localhost:3000"
USER_ID="1"

echo ""
echo "1️⃣ Testing real-time glucose monitoring..."
echo "Test case: High glucose (300 mg/dL) - should trigger CRITICAL alert"

curl -X POST "$BACKEND_URL/api/logs/glucose" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "'$USER_ID'",
    "value": 300,
    "tags": ["Test alert"],
    "notes": "Test high glucose alert"
  }' \
  -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "2️⃣ Testing real-time blood pressure monitoring..."
echo "Test case: High BP (190/120 mmHg) - should trigger CRITICAL alert"

curl -X POST "$BACKEND_URL/api/logs/blood-pressure" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "'$USER_ID'",
    "systolic": 190,
    "diastolic": 120,
    "tags": ["Test alert"],
    "notes": "Test high BP alert"
  }' \
  -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "3️⃣ Checking notifications created..."
curl -X GET "$BACKEND_URL/api/notifications?userId=$USER_ID" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "4️⃣ Testing care-circle alert distribution..."
curl -X POST "$BACKEND_URL/api/health/alert-care-circle" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "'$USER_ID'",
    "alertData": {
      "type": "glucose_critical",
      "title": "Cảnh báo đường huyết nguy hiểm",
      "message": "Đường huyết: 300 mg/dL (quá cao)",
      "severity": "critical",
      "alertType": "glucose_critical",
      "icon": "alert-circle",
      "value": 300
    }
  }' \
  -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "5️⃣ Testing manual health monitoring..."
curl -X POST "$BACKEND_URL/api/health/monitor/user/$USER_ID" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "Test completed!"
echo "Check:"
echo "- Notifications table for new health alerts" 
echo "- Care-circle members received notifications"
echo "- Real-time monitoring worked on log creation"