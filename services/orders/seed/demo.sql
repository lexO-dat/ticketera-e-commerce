-- Códigos de descuento del prototipo (seed de Supabase, ya eliminado). Solo con SEED_DEMO_DATA=true y si no hay
-- ninguno (ver src/seed.ts).
insert into promo_codes (id, code, percent_off, max_uses, used_count, valid_until, active) values
 ('c0000000-0000-0000-0000-000000000001', 'PRIMERAFILA', 10, 500, 42, now() + interval '60 days', true),
 ('c0000000-0000-0000-0000-000000000002', 'CLUB2026', 15, 200, 118, now() + interval '30 days', true),
 ('c0000000-0000-0000-0000-000000000003', 'INVIERNO', 20, 100, 100, now() - interval '5 days', false);
