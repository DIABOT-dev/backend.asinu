'use strict';

// Episode closure is not proof that the protected person checked in. Only
// their response time can distinguish an on-time check-in from a late one.
function attendance(row) {
  if (row.responded_at) {
    return new Date(row.responded_at) <= new Date(row.grace_until || row.scheduled_at)
      ? 'on_time'
      : 'late';
  }
  if (row.state === 'SCHEDULED') return 'pending';
  if (['RESOLVED', 'CANCELLED'].includes(row.state) && row.checked_in_at) {
    return new Date(row.checked_in_at) <= new Date(row.grace_until || row.scheduled_at)
      ? 'on_time'
      : 'late';
  }
  if (row.state === 'CANCELLED') return 'cancelled';
  return 'missed';
}

module.exports = { attendance };
