INSERT INTO rate_limit_events (id, space_id, event_type, created_at)
SELECT 'evt_usage_' || id, space_id, 'image_generated', created_at
FROM image_assets
WHERE NOT EXISTS (
  SELECT 1
  FROM rate_limit_events
  WHERE rate_limit_events.id = 'evt_usage_' || image_assets.id
);
