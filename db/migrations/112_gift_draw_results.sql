CREATE TABLE IF NOT EXISTS gift_draw_results (
  draw_period BIGINT NOT NULL REFERENCES gift_draw_periods(id) ON DELETE CASCADE,
  ticket_no TEXT NOT NULL REFERENCES draw_tickets(ticket_no) ON DELETE CASCADE,
  household_id BIGINT NOT NULL REFERENCES subscription_households(id) ON DELETE CASCADE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (draw_period,ticket_no)
);
CREATE TABLE IF NOT EXISTS gift_draw_result_outbox (
  draw_period BIGINT NOT NULL,
  ticket_no TEXT NOT NULL,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  PRIMARY KEY (draw_period,ticket_no,recipient_id),
  FOREIGN KEY (draw_period,ticket_no) REFERENCES gift_draw_results(draw_period,ticket_no) ON DELETE CASCADE
);
