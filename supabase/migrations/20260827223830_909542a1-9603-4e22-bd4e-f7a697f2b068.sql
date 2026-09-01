-- ENUMS
CREATE TYPE public.app_role AS ENUM ('admin');
CREATE TYPE public.event_status AS ENUM ('draft','published','soldout','archived');
CREATE TYPE public.event_category AS ENUM ('conciertos','teatro','festivales','deportes','familia');
CREATE TYPE public.section_kind AS ENUM ('seated','general');
CREATE TYPE public.order_status AS ENUM ('pending','paid','refunded','cancelled');
CREATE TYPE public.queue_state AS ENUM ('waiting','active','expired','done');
CREATE TYPE public.metric_kind AS ENUM ('view','add_to_cart','checkout','purchase');

-- UPDATED_AT HELPER
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- PROFILES
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile write" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

-- ROLES
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own roles read" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, anon, service_role;

-- VENUES
CREATE TABLE public.venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  city text NOT NULL,
  address text,
  capacity int NOT NULL DEFAULT 0,
  map_width int NOT NULL DEFAULT 1000,
  map_height int NOT NULL DEFAULT 700,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.venues TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.venues TO authenticated;
GRANT ALL ON public.venues TO service_role;
ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "venues public read" ON public.venues FOR SELECT USING (true);
CREATE POLICY "venues admin write" ON public.venues FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER venues_updated BEFORE UPDATE ON public.venues FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.venue_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind public.section_kind NOT NULL DEFAULT 'seated',
  capacity int NOT NULL DEFAULT 0,
  sort_order int NOT NULL DEFAULT 0,
  shape_x int NOT NULL DEFAULT 0,
  shape_y int NOT NULL DEFAULT 0,
  shape_w int NOT NULL DEFAULT 200,
  shape_h int NOT NULL DEFAULT 120,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.venue_sections TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.venue_sections TO authenticated;
GRANT ALL ON public.venue_sections TO service_role;
ALTER TABLE public.venue_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sections public read" ON public.venue_sections FOR SELECT USING (true);
CREATE POLICY "sections admin write" ON public.venue_sections FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.venue_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES public.venue_sections(id) ON DELETE CASCADE,
  row_label text NOT NULL,
  seat_number int NOT NULL,
  x numeric NOT NULL,
  y numeric NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  UNIQUE (section_id, row_label, seat_number)
);
GRANT SELECT ON public.venue_seats TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.venue_seats TO authenticated;
GRANT ALL ON public.venue_seats TO service_role;
ALTER TABLE public.venue_seats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "seats public read" ON public.venue_seats FOR SELECT USING (true);
CREATE POLICY "seats admin write" ON public.venue_seats FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- EVENTS
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  artist text,
  category public.event_category NOT NULL DEFAULT 'conciertos',
  description text,
  image_url text,
  status public.event_status NOT NULL DEFAULT 'draft',
  featured boolean NOT NULL DEFAULT false,
  urgency_note text,
  age_restriction text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.events TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.events TO authenticated;
GRANT ALL ON public.events TO service_role;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "events public read" ON public.events FOR SELECT USING (status IN ('published','soldout'));
CREATE POLICY "events admin read" ON public.events FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "events admin write" ON public.events FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER events_updated BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.event_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  doors_at timestamptz,
  on_sale boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.event_dates TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.event_dates TO authenticated;
GRANT ALL ON public.event_dates TO service_role;
ALTER TABLE public.event_dates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dates public read" ON public.event_dates FOR SELECT USING (true);
CREATE POLICY "dates admin write" ON public.event_dates FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.ticket_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_date_id uuid NOT NULL REFERENCES public.event_dates(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.venue_sections(id) ON DELETE CASCADE,
  name text NOT NULL,
  price numeric(12,2) NOT NULL,
  service_fee numeric(12,2) NOT NULL DEFAULT 0,
  capacity int NOT NULL DEFAULT 0,
  sold int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_date_id, section_id)
);
GRANT SELECT ON public.ticket_types TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ticket_types TO authenticated;
GRANT ALL ON public.ticket_types TO service_role;
ALTER TABLE public.ticket_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ticket types public read" ON public.ticket_types FOR SELECT USING (true);
CREATE POLICY "ticket types admin write" ON public.ticket_types FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- SEAT HOLDS
CREATE TABLE public.seat_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_date_id uuid NOT NULL REFERENCES public.event_dates(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL REFERENCES public.venue_seats(id) ON DELETE CASCADE,
  session_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  sold boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_date_id, seat_id)
);
CREATE INDEX seat_holds_session_idx ON public.seat_holds (session_token);
GRANT SELECT ON public.seat_holds TO anon, authenticated;
GRANT ALL ON public.seat_holds TO service_role;
ALTER TABLE public.seat_holds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "holds public read" ON public.seat_holds FOR SELECT USING (true);
CREATE POLICY "holds admin write" ON public.seat_holds FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- ORDERS
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code text NOT NULL UNIQUE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  buyer_name text NOT NULL,
  buyer_email text NOT NULL,
  buyer_phone text,
  buyer_document text,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  fees numeric(12,2) NOT NULL DEFAULT 0,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  promo_code text,
  status public.order_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders own read" ON public.orders FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "orders admin all" ON public.orders FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER orders_updated BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  event_date_id uuid NOT NULL REFERENCES public.event_dates(id) ON DELETE RESTRICT,
  ticket_type_id uuid NOT NULL REFERENCES public.ticket_types(id) ON DELETE RESTRICT,
  seat_id uuid REFERENCES public.venue_seats(id) ON DELETE SET NULL,
  quantity int NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL,
  unit_fee numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.order_items TO authenticated;
GRANT ALL ON public.order_items TO service_role;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order items own read" ON public.order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));
CREATE POLICY "order items admin all" ON public.order_items FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  ticket_code text NOT NULL UNIQUE,
  attendee_name text,
  checked_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tickets TO authenticated;
GRANT ALL ON public.tickets TO service_role;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tickets own read" ON public.tickets FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));
CREATE POLICY "tickets admin all" ON public.tickets FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- VIRTUAL QUEUE
CREATE TABLE public.queue_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES public.events(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  concurrent_slots int NOT NULL DEFAULT 200,
  window_minutes int NOT NULL DEFAULT 10,
  waiting_message text,
  simulated_queue_size int NOT NULL DEFAULT 1200,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.queue_config TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.queue_config TO authenticated;
GRANT ALL ON public.queue_config TO service_role;
ALTER TABLE public.queue_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "queue config public read" ON public.queue_config FOR SELECT USING (true);
CREATE POLICY "queue config admin write" ON public.queue_config FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER queue_config_updated BEFORE UPDATE ON public.queue_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.queue_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  session_token text NOT NULL,
  position int NOT NULL DEFAULT 0,
  state public.queue_state NOT NULL DEFAULT 'waiting',
  entered_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  expires_at timestamptz,
  UNIQUE (event_id, session_token)
);
GRANT SELECT ON public.queue_sessions TO anon, authenticated;
GRANT ALL ON public.queue_sessions TO service_role;
ALTER TABLE public.queue_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "queue sessions public read" ON public.queue_sessions FOR SELECT USING (true);
CREATE POLICY "queue sessions admin write" ON public.queue_sessions FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- PROMO CODES
CREATE TABLE public.promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  percent_off int NOT NULL DEFAULT 0,
  max_uses int NOT NULL DEFAULT 100,
  used_count int NOT NULL DEFAULT 0,
  valid_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promo_codes TO authenticated;
GRANT ALL ON public.promo_codes TO service_role;
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "promo admin all" ON public.promo_codes FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- METRICS
CREATE TABLE public.event_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  kind public.metric_kind NOT NULL,
  quantity int NOT NULL DEFAULT 1,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_metrics_event_idx ON public.event_metrics (event_id, kind);
GRANT SELECT ON public.event_metrics TO authenticated;
GRANT ALL ON public.event_metrics TO service_role;
ALTER TABLE public.event_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "metrics admin read" ON public.event_metrics FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- NEWSLETTER
CREATE TABLE public.newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT ON public.newsletter_subscribers TO anon, authenticated;
GRANT SELECT, DELETE ON public.newsletter_subscribers TO authenticated;
GRANT ALL ON public.newsletter_subscribers TO service_role;
ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "newsletter public insert" ON public.newsletter_subscribers FOR INSERT WITH CHECK (true);
CREATE POLICY "newsletter admin read" ON public.newsletter_subscribers FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- ===================== SEED =====================
INSERT INTO public.venues (id, name, city, address, capacity, map_width, map_height) VALUES
 ('11111111-1111-1111-1111-111111111111','Arena Central','Santiago','Av. Beaucheff 1200, Santiago',12000,1000,760),
 ('22222222-2222-2222-2222-222222222222','Teatro Municipal Norte','Valparaíso','Calle Prat 455, Valparaíso',1400,1000,760),
 ('33333333-3333-3333-3333-333333333333','Parque La Ribera','Santiago','Camino La Ribera 900, Santiago',30000,1000,760);

-- Arena Central sections
INSERT INTO public.venue_sections (id, venue_id, name, kind, capacity, sort_order, shape_x, shape_y, shape_w, shape_h) VALUES
 ('a1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Cancha General','general',4000,1,330,300,340,180),
 ('a1000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Platea Baja A','seated',240,2,120,300,180,180),
 ('a1000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Platea Baja B','seated',240,3,700,300,180,180),
 ('a1000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Platea Alta','seated',420,4,120,520,760,180),
 ('a1000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','VIP Frontal','seated',120,0,330,180,340,90);

INSERT INTO public.venue_sections (id, venue_id, name, kind, capacity, sort_order, shape_x, shape_y, shape_w, shape_h) VALUES
 ('a2000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Platea','seated',300,1,200,240,600,200),
 ('a2000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Balcón','seated',180,2,200,480,600,140);

INSERT INTO public.venue_sections (id, venue_id, name, kind, capacity, sort_order, shape_x, shape_y, shape_w, shape_h) VALUES
 ('a3000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','Campo General','general',20000,1,120,300,760,300),
 ('a3000000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','Golden Pit','general',3000,0,330,200,340,80);

-- Generate seats for seated sections
DO $$
DECLARE
  s record;
  rows_n int; cols_n int; r int; c int; ox numeric; oy numeric; gap numeric := 18;
BEGIN
  FOR s IN SELECT * FROM public.venue_sections WHERE kind = 'seated' LOOP
    cols_n := GREATEST(8, LEAST(24, floor(s.shape_w / gap)::int));
    rows_n := GREATEST(4, LEAST(14, ceil(s.capacity::numeric / cols_n)::int));
    ox := s.shape_x + 12;
    oy := s.shape_y + 14;
    FOR r IN 1..rows_n LOOP
      FOR c IN 1..cols_n LOOP
        INSERT INTO public.venue_seats (section_id, row_label, seat_number, x, y, blocked)
        VALUES (s.id, chr(64 + r), c, ox + (c - 1) * gap, oy + (r - 1) * gap, (r = 1 AND c = 1));
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- Events
INSERT INTO public.events (id, slug, title, artist, category, description, image_url, status, featured, urgency_note, age_restriction) VALUES
 ('e0000000-0000-0000-0000-000000000001','lumen-tour-santiago','Lumen Tour 2026','Lumen','conciertos','La gira más ambiciosa de Lumen llega con una producción de luz total, banda completa y un repertorio que recorre sus tres discos.',NULL,'published',true,'Últimas entradas','TE'),
 ('e0000000-0000-0000-0000-000000000002','nocturna-festival','Nocturna Festival','Varios artistas','festivales','Dos escenarios, catorce actos y una noche completa de música electrónica y pop alternativo en el Parque La Ribera.',NULL,'published',true,NULL,'18+'),
 ('e0000000-0000-0000-0000-000000000003','maria-de-los-andes','María de los Andes','Compañía Teatro Norte','teatro','Una obra de cámara sobre la memoria y el desplazamiento, montada en el Teatro Municipal Norte.',NULL,'published',false,NULL,'TE'),
 ('e0000000-0000-0000-0000-000000000004','clasico-de-invierno','Clásico de Invierno','Selección Nacional','deportes','El partido de la temporada en la Arena Central, con aforo completo y sectores numerados.',NULL,'published',false,'Quedan pocos sectores','TE'),
 ('e0000000-0000-0000-0000-000000000005','circo-de-papel','Circo de Papel','Compañía Papel','familia','Espectáculo familiar de circo contemporáneo con música en vivo y escenografía de papel reciclado.',NULL,'published',false,NULL,'TE'),
 ('e0000000-0000-0000-0000-000000000006','arauco-sinfonico','Arauco Sinfónico','Orquesta Arauco','conciertos','La Orquesta Arauco interpreta un programa de compositores latinoamericanos del siglo XX.',NULL,'published',false,NULL,'TE'),
 ('e0000000-0000-0000-0000-000000000007','ruido-blanco','Ruido Blanco','Ruido Blanco','conciertos','Regreso a los escenarios tras seis años, con formación original y set acústico de cierre.',NULL,'published',true,NULL,'18+'),
 ('e0000000-0000-0000-0000-000000000008','maraton-de-la-costa','Maratón de la Costa','Organización Costa','deportes','Inscripción para la maratón 42K, media maratón y 10K por el borde costero.',NULL,'published',false,NULL,'TE');

INSERT INTO public.event_dates (id, event_id, venue_id, starts_at, doors_at, on_sale) VALUES
 ('d0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', now() + interval '32 days', now() + interval '32 days' - interval '2 hours', true),
 ('d0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', now() + interval '33 days', now() + interval '33 days' - interval '2 hours', true),
 ('d0000000-0000-0000-0000-000000000003','e0000000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333', now() + interval '58 days', now() + interval '58 days' - interval '3 hours', true),
 ('d0000000-0000-0000-0000-000000000004','e0000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222', now() + interval '12 days', now() + interval '12 days' - interval '1 hours', true),
 ('d0000000-0000-0000-0000-000000000005','e0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111', now() + interval '21 days', now() + interval '21 days' - interval '2 hours', true),
 ('d0000000-0000-0000-0000-000000000006','e0000000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222', now() + interval '9 days', now() + interval '9 days' - interval '1 hours', true),
 ('d0000000-0000-0000-0000-000000000007','e0000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222', now() + interval '45 days', now() + interval '45 days' - interval '1 hours', true),
 ('d0000000-0000-0000-0000-000000000008','e0000000-0000-0000-0000-000000000007','11111111-1111-1111-1111-111111111111', now() + interval '75 days', now() + interval '75 days' - interval '2 hours', true),
 ('d0000000-0000-0000-0000-000000000009','e0000000-0000-0000-0000-000000000008','33333333-3333-3333-3333-333333333333', now() + interval '90 days', now() + interval '90 days' - interval '2 hours', true);

-- Ticket types: one per section of the date's venue, priced by section order
INSERT INTO public.ticket_types (event_date_id, section_id, name, price, service_fee, capacity, sold)
SELECT d.id, s.id, s.name,
       (CASE s.sort_order WHEN 0 THEN 145000 WHEN 1 THEN 62000 WHEN 2 THEN 89000 WHEN 3 THEN 89000 ELSE 54000 END)::numeric,
       (CASE s.sort_order WHEN 0 THEN 14500 WHEN 1 THEN 6200 WHEN 2 THEN 8900 WHEN 3 THEN 8900 ELSE 5400 END)::numeric,
       s.capacity,
       floor(s.capacity * 0.35)::int
FROM public.event_dates d
JOIN public.venue_sections s ON s.venue_id = d.venue_id;

-- Queue config
INSERT INTO public.queue_config (event_id, enabled, concurrent_slots, window_minutes, waiting_message, simulated_queue_size) VALUES
 ('e0000000-0000-0000-0000-000000000001', true, 250, 10, 'Estás en la fila virtual. No recargues la página: perderás tu posición.', 3400),
 ('e0000000-0000-0000-0000-000000000002', true, 400, 8, 'Alta demanda. Te avisaremos cuando sea tu turno.', 5200),
 ('e0000000-0000-0000-0000-000000000007', true, 150, 12, 'Fila virtual activa por alta demanda.', 1800),
 ('e0000000-0000-0000-0000-000000000003', false, 200, 10, NULL, 0),
 ('e0000000-0000-0000-0000-000000000004', false, 200, 10, NULL, 0),
 ('e0000000-0000-0000-0000-000000000005', false, 200, 10, NULL, 0),
 ('e0000000-0000-0000-0000-000000000006', false, 200, 10, NULL, 0),
 ('e0000000-0000-0000-0000-000000000008', false, 200, 10, NULL, 0);

INSERT INTO public.promo_codes (code, percent_off, max_uses, used_count, valid_until, active) VALUES
 ('PRIMERAFILA', 10, 500, 42, now() + interval '60 days', true),
 ('CLUB2026', 15, 200, 118, now() + interval '30 days', true),
 ('INVIERNO', 20, 100, 100, now() - interval '5 days', false);

-- Sample metrics for the last 30 days
INSERT INTO public.event_metrics (event_id, kind, quantity, amount, created_at)
SELECT e.id,
       (ARRAY['view','view','view','add_to_cart','add_to_cart','checkout','purchase']::public.metric_kind[])[1 + (g % 7)],
       1 + (g % 4),
       CASE WHEN (g % 7) = 6 THEN 62000 + (g % 5) * 27000 ELSE 0 END,
       now() - (g || ' hours')::interval
FROM public.events e
CROSS JOIN generate_series(1, 90) g
WHERE e.status = 'published';