#!/bin/bash

# Script để setup daily health monitoring cronjob
# Chạy health monitoring mỗi ngày lúc 8:00 AM

BACKEND_URL="http://localhost:3000"  # Hoặc URL production của bạn
CRON_TIME="0 8 * * *"  # 8:00 AM hàng ngày

echo "Setting up daily health monitoring cronjob..."

# Tạo script wrapper
cat > /tmp/health-monitoring.sh << EOF
#!/bin/bash
# Daily health monitoring script
# Generated on: $(date)

# Log output
LOGFILE="/var/log/health-monitoring.log"

echo "\$(date): Starting daily health monitoring" >> \$LOGFILE

# Call health monitoring endpoint
curl -X POST \\
  -H "Content-Type: application/json" \\
  -w "HTTP Status: %{http_code}\n" \\
  "$BACKEND_URL/api/health/monitor/daily" \\
  >> \$LOGFILE 2>&1

echo "\$(date): Daily health monitoring completed" >> \$LOGFILE
echo "----------------------------------------" >> \$LOGFILE
EOF

# Make executable
chmod +x /tmp/health-monitoring.sh

# Add to crontab
(crontab -l 2>/dev/null; echo "$CRON_TIME /tmp/health-monitoring.sh") | crontab -

echo "Cronjob added successfully!"
echo "Schedule: $CRON_TIME (8:00 AM daily)"
echo "Script: /tmp/health-monitoring.sh"
echo "Logs: /var/log/health-monitoring.log"
echo ""
echo "To view current crontab: crontab -l"
echo "To check logs: tail -f /var/log/health-monitoring.log"
echo "To test manually: /tmp/health-monitoring.sh"