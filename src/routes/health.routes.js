const express = require('express');
const { runDailyHealthMonitoring, runHealthMonitoringForUser } = require('../services/health.monitoring.service');
const { requireAuth } = require('../middleware/auth.middleware');
const { t, getLang } = require('../i18n');

function healthRoutes(pool) {
  const router = express.Router();

  /**
   * POST /api/health/monitor/daily
   * Chạy daily health monitoring cho tất cả users
   * Thường được gọi bởi cronjob
   */
  router.post('/monitor/daily', async (req, res) => {
    try {
      console.log('[health] Manual trigger: daily monitoring');
      const result = await runDailyHealthMonitoring(pool);
      
      return res.status(200).json({
        ok: true,
        message: t('health.daily_check_complete', getLang(req)),
        ...result
      });
    } catch (error) {
      console.error('[health] Error in daily monitoring endpoint:', error);
      return res.status(500).json({
        ok: false,
        error: t('health.daily_check_error', getLang(req))
      });
    }
  });

  // Endpoint để gửi cảnh báo health cho care-circle  
  router.post('/alert-care-circle', async (req, res) => {
    const { userId, alertData } = req.body;
    
    try {
      // Tìm tất cả care-circle connections của user
      const connectionsQuery = `
        SELECT 
          CASE 
            WHEN requester_id = $1 THEN addressee_id
            WHEN addressee_id = $1 THEN requester_id
          END as care_member_id,
          u.full_name as care_member_name
        FROM user_connections uc
        JOIN users u ON (
          (uc.requester_id = $1 AND u.id = uc.addressee_id) OR
          (uc.addressee_id = $1 AND u.id = uc.requester_id)
        )
        WHERE uc.status = 'accepted'
        AND (uc.requester_id = $1 OR uc.addressee_id = $1)
      `;
      
      const connections = await pool.query(connectionsQuery, [userId]);
      
      if (connections.rows.length === 0) {
        return res.status(200).json({ 
          message: t('careCircle.no_care_circle', getLang(req)),
          notified: 0 
        });
      }
      
      // Lấy thông tin user gửi cảnh báo
      const userQuery = 'SELECT full_name FROM users WHERE id = $1';
      const userResult = await pool.query(userQuery, [userId]);
      const userName = userResult.rows[0]?.full_name || `User ${userId}`;
      
      // Tạo notification cho từng thành viên care-circle
      const notifications = [];
      for (const connection of connections.rows) {
        const notificationData = {
          user_id: connection.care_member_id,
          type: 'health_alert',
          title: t('health.alert_from_user', getLang(req), { name: userName }),
          message: alertData.message,
          data: {
            type: 'health_alert',
            alertType: alertData.alertType,
            severity: alertData.severity,
            icon: alertData.icon || (alertData.severity === 'critical' ? 'alert-circle' : 'warning'),
            sourceUserId: userId,
            sourceUserName: userName,
            ...alertData
          },
          is_read: false,
          created_at: new Date(),
          updated_at: new Date()
        };
        
        notifications.push(notificationData);
      }
      
      // Insert tất cả notifications
      if (notifications.length > 0) {
        const insertQuery = `
          INSERT INTO notifications (user_id, type, title, message, data, is_read, created_at, updated_at)
          VALUES ${notifications.map((_, index) => 
            `($${index * 8 + 1}, $${index * 8 + 2}, $${index * 8 + 3}, $${index * 8 + 4}, $${index * 8 + 5}, $${index * 8 + 6}, $${index * 8 + 7}, $${index * 8 + 8})`
          ).join(', ')}
        `;
        
        const insertValues = notifications.flatMap(n => [
          n.user_id, n.type, n.title, n.message, 
          JSON.stringify(n.data), n.is_read, n.created_at, n.updated_at
        ]);
        
        await pool.query(insertQuery, insertValues);
      }
      
      res.json({
        success: true,
        message: t('health.alert_sent_count', getLang(req), { count: connections.rows.length }),
        notified: connections.rows.length,
        alertType: alertData.alertType,
        severity: alertData.severity
      });
      
    } catch (error) {
      console.error('Lỗi gửi cảnh báo care-circle:', error);
      res.status(500).json({
        error: t('health.alert_send_error', getLang(req)),
        details: error.message
      });
    }
  });

  /**
   * POST /api/health/monitor/user/:userId
   * Chạy health monitoring cho user cụ thể
   * Để test hoặc trigger manual
   */
  router.post('/monitor/user/:userId', requireAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          ok: false,
          error: t('error.invalid_user_id', getLang(req))
        });
      }

      console.log(`[health] Manual trigger: monitoring for user ${userId}`);
      await runHealthMonitoringForUser(pool, userId);
      
      return res.status(200).json({
        ok: true,
        message: t('health.user_check_complete', getLang(req), { userId })
      });
    } catch (error) {
      console.error('[health] Error in user monitoring endpoint:', error);
      return res.status(500).json({
        ok: false,
        error: t('health.user_check_error', getLang(req))
      });
    }
  });

  return router;
}

module.exports = healthRoutes;