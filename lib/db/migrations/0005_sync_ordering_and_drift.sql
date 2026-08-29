ALTER TABLE "erp_sync_records" ADD COLUMN "drift_reason" text;--> statement-breakpoint
ALTER TABLE "erp_sync_records" ADD COLUMN "drift_detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_event_at" timestamp with time zone;