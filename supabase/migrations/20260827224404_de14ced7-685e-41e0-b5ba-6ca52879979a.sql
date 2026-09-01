ALTER TABLE public.venues ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.venue_sections ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 0;
ALTER TABLE public.venue_seats ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS age_restriction text;
ALTER TABLE public.ticket_types ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buyer_document text;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS attendee_name text;
ALTER TABLE public.event_metrics ADD COLUMN IF NOT EXISTS amount numeric NOT NULL DEFAULT 0;
ALTER TABLE public.queue_config ADD COLUMN IF NOT EXISTS concurrent_slots integer NOT NULL DEFAULT 50;
ALTER TABLE public.queue_sessions ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE public.promo_codes ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

UPDATE public.venue_sections s
SET capacity = COALESCE((SELECT count(*) FROM public.venue_seats vs WHERE vs.section_id = s.id), 0)
WHERE s.capacity = 0;

UPDATE public.venue_sections SET capacity = 500 WHERE capacity = 0;

UPDATE public.ticket_types t
SET capacity = COALESCE((SELECT s.capacity FROM public.venue_sections s WHERE s.id = t.section_id), 500)
WHERE t.capacity = 0;