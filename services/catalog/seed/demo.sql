-- Datos de demostración, migrados de supabase/migrations (seed del prototipo).
-- Solo se cargan con SEED_DEMO_DATA=true y si el catálogo está vacío (ver src/seed.ts).
-- Se conservan los UUID de recintos, sectores, eventos y fechas del prototipo; butacas y tipos de
-- entrada (que allá eran aleatorios) usan UUID deterministas para que el seed sea reproducible.

insert into venues (id, name, city, address, capacity, map_width, map_height) values
 ('11111111-1111-1111-1111-111111111111', 'Arena Central', 'Santiago', 'Av. Beaucheff 1200, Santiago', 12000, 1000, 760),
 ('22222222-2222-2222-2222-222222222222', 'Teatro Municipal Norte', 'Valparaíso', 'Calle Prat 455, Valparaíso', 1400, 1000, 760),
 ('33333333-3333-3333-3333-333333333333', 'Parque La Ribera', 'Santiago', 'Camino La Ribera 900, Santiago', 30000, 1000, 760);

insert into venue_sections (id, venue_id, name, kind, capacity, sort_order, shape_x, shape_y, shape_w, shape_h) values
 ('a1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Cancha General', 'general', 4000, 1, 330, 300, 340, 180),
 ('a1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Platea Baja A', 'seated', 240, 2, 120, 300, 180, 180),
 ('a1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Platea Baja B', 'seated', 240, 3, 700, 300, 180, 180),
 ('a1000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Platea Alta', 'seated', 420, 4, 120, 520, 760, 180),
 ('a1000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'VIP Frontal', 'seated', 120, 0, 330, 180, 340, 90),
 ('a2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Platea', 'seated', 300, 1, 200, 240, 600, 200),
 ('a2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Balcón', 'seated', 180, 2, 200, 480, 600, 140),
 ('a3000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'Campo General', 'general', 20000, 1, 120, 300, 760, 300),
 ('a3000000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'Golden Pit', 'general', 3000, 0, 330, 200, 340, 80);

-- Butacas de los sectores numerados (misma grilla que el prototipo: 18 px entre butacas, la
-- primera de cada sector bloqueada).
insert into venue_seats (id, section_id, row_label, seat_number, x, y, blocked)
select md5('seat:' || s.id || ':' || r || ':' || c)::uuid, s.id, chr(64 + r), c,
       s.shape_x + 12 + (c - 1) * 18, s.shape_y + 14 + (r - 1) * 18, (r = 1 and c = 1)
from venue_sections s
cross join lateral (
  select greatest(8, least(24, floor(s.shape_w / 18.0)::int)) as cols
) g
cross join lateral generate_series(1, greatest(4, least(14, ceil(s.capacity::numeric / g.cols)::int))) r
cross join lateral generate_series(1, g.cols) c
where s.kind = 'seated';

-- La capacidad de un sector numerado es su cantidad de butacas.
update venue_sections s
set capacity = (select count(*) from venue_seats v where v.section_id = s.id)
where s.kind = 'seated';

insert into events (id, slug, title, artist, category, description, status, featured, urgency_note, age_restriction) values
 ('e0000000-0000-0000-0000-000000000001', 'lumen-tour-santiago', 'Lumen Tour 2026', 'Lumen', 'conciertos', 'La gira más ambiciosa de Lumen llega con una producción de luz total, banda completa y un repertorio que recorre sus tres discos.', 'published', true, 'Últimas entradas', 'TE'),
 ('e0000000-0000-0000-0000-000000000002', 'nocturna-festival', 'Nocturna Festival', 'Varios artistas', 'festivales', 'Dos escenarios, catorce actos y una noche completa de música electrónica y pop alternativo en el Parque La Ribera.', 'published', true, null, '18+'),
 ('e0000000-0000-0000-0000-000000000003', 'maria-de-los-andes', 'María de los Andes', 'Compañía Teatro Norte', 'teatro', 'Una obra de cámara sobre la memoria y el desplazamiento, montada en el Teatro Municipal Norte.', 'published', false, null, 'TE'),
 ('e0000000-0000-0000-0000-000000000004', 'clasico-de-invierno', 'Clásico de Invierno', 'Selección Nacional', 'deportes', 'El partido de la temporada en la Arena Central, con aforo completo y sectores numerados.', 'published', false, 'Quedan pocos sectores', 'TE'),
 ('e0000000-0000-0000-0000-000000000005', 'circo-de-papel', 'Circo de Papel', 'Compañía Papel', 'familia', 'Espectáculo familiar de circo contemporáneo con música en vivo y escenografía de papel reciclado.', 'published', false, null, 'TE'),
 ('e0000000-0000-0000-0000-000000000006', 'arauco-sinfonico', 'Arauco Sinfónico', 'Orquesta Arauco', 'conciertos', 'La Orquesta Arauco interpreta un programa de compositores latinoamericanos del siglo XX.', 'published', false, null, 'TE'),
 ('e0000000-0000-0000-0000-000000000007', 'ruido-blanco', 'Ruido Blanco', 'Ruido Blanco', 'conciertos', 'Regreso a los escenarios tras seis años, con formación original y set acústico de cierre.', 'published', true, null, '18+'),
 ('e0000000-0000-0000-0000-000000000008', 'maraton-de-la-costa', 'Maratón de la Costa', 'Organización Costa', 'deportes', 'Inscripción para la maratón 42K, media maratón y 10K por el borde costero.', 'published', false, null, 'TE');

-- Fechas relativas al momento del seed (como en el prototipo), a las 21:00 hora de Chile.
insert into event_dates (id, event_id, venue_id, starts_at, doors_at, on_sale)
select d.id::uuid, d.event_id::uuid, d.venue_id::uuid, t.starts_at, t.starts_at - d.doors_before, true
from (values
  ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 32, interval '2 hours'),
  ('d0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 33, interval '2 hours'),
  ('d0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 58, interval '3 hours'),
  ('d0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 12, interval '1 hour'),
  ('d0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 21, interval '2 hours'),
  ('d0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 9, interval '1 hour'),
  ('d0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222222', 45, interval '1 hour'),
  ('d0000000-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 75, interval '2 hours'),
  ('d0000000-0000-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000008', '33333333-3333-3333-3333-333333333333', 90, interval '2 hours')
) as d (id, event_id, venue_id, days_ahead, doors_before)
cross join lateral (
  select ((current_date + d.days_ahead)::timestamp + time '21:00') at time zone 'America/Santiago' as starts_at
) t;

-- Un tipo de entrada por sector del recinto de cada fecha, con el precio según el orden del sector.
insert into ticket_types (id, event_date_id, section_id, name, price, service_fee, capacity)
select md5('ticket-type:' || d.id || ':' || s.id)::uuid, d.id, s.id, s.name,
       case s.sort_order when 0 then 145000 when 1 then 62000 when 2 then 89000 when 3 then 89000 else 54000 end,
       case s.sort_order when 0 then 14500 when 1 then 6200 when 2 then 8900 when 3 then 8900 else 5400 end,
       s.capacity
from event_dates d
join venue_sections s on s.venue_id = d.venue_id;

-- Productos (RF03, RF14): no existían en el prototipo.
insert into products (id, slug, name, description, sku, price, image_id, event_id, status, max_per_order) values
 ('b0000000-0000-0000-0000-000000000001', 'polera-lumen-tour-2026', 'Polera Lumen Tour 2026', 'Polera de algodón orgánico con el arte oficial de la gira.', 'LUM-POL-2026', 24990, null, 'e0000000-0000-0000-0000-000000000001', 'active', 5),
 ('b0000000-0000-0000-0000-000000000002', 'vinilo-ruido-blanco', 'Vinilo Ruido Blanco — Reedición', 'Reedición en vinilo de 180 g del primer disco, con lámina firmada.', 'RB-VIN-01', 32990, null, 'e0000000-0000-0000-0000-000000000007', 'active', 3),
 ('b0000000-0000-0000-0000-000000000003', 'botella-nocturna', 'Botella reutilizable Nocturna', 'Botella de acero de 750 ml. Recárgala gratis dentro del festival.', 'NOC-BOT-750', 12990, null, 'e0000000-0000-0000-0000-000000000002', 'active', 4);
