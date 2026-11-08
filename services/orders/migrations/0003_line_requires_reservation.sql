-- Si la línea exigía una reserva de inventory (ItemVendible.requiresReservation). La confirmación
-- vuelve a comprobarlo: una línea que la exige sin reserva no se vende y el cobro se reembolsa.
alter table order_lines add column requires_reservation boolean not null default false;
