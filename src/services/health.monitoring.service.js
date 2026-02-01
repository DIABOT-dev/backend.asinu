/**
 * Health Monitoring Service
 * Kiểm tra các metrics sức khỏe và gửi cảnh báo qua notifications
 * 
 * Chạy cronjob hàng ngày để:
 * 1. Kiểm tra đường huyết, huyết áp bất thường
 * 2. Kiểm tra việc không ghi log quá lâu  
 * 3. Gửi thông báo cho care circle connections
 */

/**
 * Kiểm tra các giá trị đường huyết bất thường
 * @param {object} pool - Database pool
 * @param {number} userId - User ID cần kiểm tra
 * @returns {object|null} Alert object nếu có vấn đề
 */
async function checkGlucoseAlerts(pool, userId) {
  try {
    // Lấy logs đường huyết 24h gần nhất
    const result = await pool.query(
      `SELECT * FROM user_logs 
       WHERE user_id = $1 AND type = 'glucose' 
       AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId]
    );

    const glucoseLogs = result.rows;
    
    if (glucoseLogs.length === 0) {
      return {
        type: 'no_glucose_data',
        severity: 'medium',
        message: 'Chưa có dữ liệu đường huyết trong 24h qua',
        userId
      };
    }

    // Kiểm tra giá trị bất thường
    const latestLog = glucoseLogs[0];
    const glucose = latestLog.value;

    if (glucose > 250) {
      return {
        type: 'high_glucose',
        severity: 'high',
        message: `Đường huyết cao bất thường: ${glucose} mg/dL`,
        userId,
        value: glucose
      };
    }

    if (glucose < 70) {
      return {
        type: 'low_glucose',
        severity: 'high', 
        message: `Đường huyết thấp nguy hiểm: ${glucose} mg/dL`,
        userId,
        value: glucose
      };
    }

    // Kiểm tra xu hướng tăng liên tục
    if (glucoseLogs.length >= 3) {
      const isIncreasing = glucoseLogs.slice(0, 3).every((log, idx) => 
        idx === 0 || log.value > glucoseLogs[idx - 1].value
      );
      
      if (isIncreasing && glucose > 180) {
        return {
          type: 'glucose_trend_up',
          severity: 'medium',
          message: `Đường huyết có xu hướng tăng liên tục: ${glucose} mg/dL`,
          userId,
          value: glucose
        };
      }
    }

    return null;
  } catch (error) {
    console.error('[health] Error checking glucose alerts:', error);
    return null;
  }
}

/**
 * Kiểm tra huyết áp bất thường
 * @param {object} pool - Database pool  
 * @param {number} userId - User ID cần kiểm tra
 * @returns {object|null} Alert object nếu có vấn đề
 */
async function checkBloodPressureAlerts(pool, userId) {
  try {
    const result = await pool.query(
      `SELECT * FROM user_logs 
       WHERE user_id = $1 AND type = 'blood-pressure'
       AND created_at >= NOW() - INTERVAL '24 hours'  
       ORDER BY created_at DESC
       LIMIT 3`,
      [userId]
    );

    const bpLogs = result.rows;
    
    if (bpLogs.length === 0) return null;

    const latestLog = bpLogs[0];
    const systolic = latestLog.systolic;
    const diastolic = latestLog.diastolic;

    // Huyết áp cao
    if (systolic >= 180 || diastolic >= 110) {
      return {
        type: 'high_blood_pressure',
        severity: 'high',
        message: `Huyết áp cao: ${systolic}/${diastolic} mmHg`,
        userId,
        systolic,
        diastolic
      };
    }

    // Huyết áp thấp
    if (systolic < 90 || diastolic < 60) {
      return {
        type: 'low_blood_pressure', 
        severity: 'medium',
        message: `Huyết áp thấp: ${systolic}/${diastolic} mmHg`,
        userId,
        systolic,
        diastolic
      };
    }

    return null;
  } catch (error) {
    console.error('[health] Error checking blood pressure alerts:', error);
    return null;
  }
}

/**
 * Kiểm tra việc không ghi log quá lâu
 * @param {object} pool - Database pool
 * @param {number} userId - User ID cần kiểm tra 
 * @returns {object|null} Alert object nếu có vấn đề
 */
async function checkInactivityAlerts(pool, userId) {
  try {
    const result = await pool.query(
      `SELECT MAX(created_at) as last_log_time
       FROM user_logs 
       WHERE user_id = $1 AND type IN ('glucose', 'blood-pressure', 'weight')`,
      [userId]
    );

    const lastLogTime = result.rows[0]?.last_log_time;
    
    if (!lastLogTime) {
      return {
        type: 'no_activity',
        severity: 'medium',
        message: 'Chưa có dữ liệu sức khỏe nào được ghi nhận',
        userId
      };
    }

    const daysSinceLastLog = (new Date() - new Date(lastLogTime)) / (1000 * 60 * 60 * 24);
    
    if (daysSinceLastLog > 3) {
      return {
        type: 'inactive_user',
        severity: 'medium',
        message: `Đã ${Math.floor(daysSinceLastLog)} ngày không ghi log sức khỏe`,
        userId,
        daysSince: Math.floor(daysSinceLastLog)
      };
    }

    return null;
  } catch (error) {
    console.error('[health] Error checking inactivity alerts:', error);
    return null;
  }
}

/**
 * Lấy danh sách care circle connections của user
 * @param {object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {array} Danh sách connection IDs
 */
async function getCareCircleConnections(pool, userId) {
  try {
    const result = await pool.query(
      `SELECT 
        CASE 
          WHEN requester_id = $1 THEN addressee_id
          ELSE requester_id  
        END as connection_user_id
       FROM user_connections 
       WHERE status = 'accepted' 
         AND (requester_id = $1 OR addressee_id = $1)`,
      [userId]
    );

    return result.rows.map(row => row.connection_user_id);
  } catch (error) {
    console.error('[health] Error getting care circle connections:', error);
    return [];
  }
}

/**
 * Tạo notification cho users
 * @param {object} pool - Database pool
 * @param {array} userIds - Danh sách user IDs nhận notification
 * @param {object} alert - Alert object 
 * @param {string} patientName - Tên người bệnh
 */
async function createHealthNotifications(pool, userIds, alert, patientName) {
  try {
    for (const userId of userIds) {
      await pool.query(
        `INSERT INTO notifications (
          user_id,
          type,
          title,
          message,
          data,
          is_read,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          userId,
          'health_alert',
          `Cảnh báo sức khỏe: ${patientName}`,
          alert.message,
          JSON.stringify({
            alertType: alert.type,
            severity: alert.severity,
            patientUserId: alert.userId,
            value: alert.value || null,
            systolic: alert.systolic || null,
            diastolic: alert.diastolic || null
          }),
          false
        ]
      );
    }

    console.log(`[health] Created ${userIds.length} notifications for alert: ${alert.type}`);
  } catch (error) {
    console.error('[health] Error creating health notifications:', error);
  }
}

/**
 * Chạy health monitoring cho một user
 * @param {object} pool - Database pool
 * @param {number} userId - User ID cần kiểm tra
 */
async function runHealthMonitoringForUser(pool, userId) {
  try {
    // Lấy thông tin user
    const userResult = await pool.query(
      'SELECT full_name, email FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) return;
    
    const userName = userResult.rows[0].full_name || userResult.rows[0].email || `User ${userId}`;

    // Kiểm tra các loại cảnh báo
    const alerts = [];
    
    const glucoseAlert = await checkGlucoseAlerts(pool, userId);
    if (glucoseAlert) alerts.push(glucoseAlert);

    const bpAlert = await checkBloodPressureAlerts(pool, userId);
    if (bpAlert) alerts.push(bpAlert);

    const inactivityAlert = await checkInactivityAlerts(pool, userId);
    if (inactivityAlert) alerts.push(inactivityAlert);

    // Nếu có cảnh báo, gửi đến care circle
    if (alerts.length > 0) {
      const connections = await getCareCircleConnections(pool, userId);
      
      if (connections.length > 0) {
        for (const alert of alerts) {
          await createHealthNotifications(pool, connections, alert, userName);
        }
      }

      console.log(`[health] Found ${alerts.length} alerts for user ${userId}, notified ${connections.length} connections`);
    }

  } catch (error) {
    console.error(`[health] Error running monitoring for user ${userId}:`, error);
  }
}

/**
 * Chạy health monitoring cho tất cả users có care circle
 * @param {object} pool - Database pool
 */
async function runDailyHealthMonitoring(pool) {
  try {
    console.log('[health] Starting daily health monitoring...');

    // Lấy danh sách users có care circle connections
    const result = await pool.query(
      `SELECT DISTINCT 
        CASE 
          WHEN requester_id IS NOT NULL THEN requester_id
          WHEN addressee_id IS NOT NULL THEN addressee_id
        END as user_id
       FROM user_connections 
       WHERE status = 'accepted'
       ORDER BY user_id`
    );

    const userIds = [...new Set([
      ...result.rows.map(r => r.user_id).filter(Boolean)
    ])];

    console.log(`[health] Monitoring ${userIds.length} users with care circle connections`);

    // Chạy monitoring cho từng user
    for (const userId of userIds) {
      await runHealthMonitoringForUser(pool, userId);
      // Delay ngắn để tránh overload
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('[health] Daily health monitoring completed');
    return { success: true, usersMonitored: userIds.length };

  } catch (error) {
    console.error('[health] Error in daily health monitoring:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  checkGlucoseAlerts,
  checkBloodPressureAlerts,
  checkInactivityAlerts,
  getCareCircleConnections,
  createHealthNotifications,
  runHealthMonitoringForUser,
  runDailyHealthMonitoring
};