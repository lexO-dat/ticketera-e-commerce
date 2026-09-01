import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, OutlineButton, PillButton } from "@/components/kit/PillButton";
import { Field, Select, TextArea, TextInput } from "@/components/kit/Field";
import {
  adminDeleteDate,
  adminDeleteEvent,
  adminEvents,
  adminResetQueue,
  adminSaveDate,
  adminSaveEvent,
  adminSaveQueue,
  adminVenues,
} from "@/lib/admin.functions";
import { CATEGORIES, CATEGORY_LABELS, dateAndTime, money } from "@/lib/format";

export const Route = createFileRoute("/admin/eventos")({
  component: AdminEvents,
});

type EventForm = {
  id: string | null;
  title: string;
  artist: string;
  category: (typeof CATEGORIES)[number];
  description: string;
  imageUrl: string;
  status: "draft" | "published" | "soldout" | "archived";
  featured: boolean;
  urgencyNote: string;
  ageRestriction: string;
};

const emptyEvent: EventForm = {
  id: null,
  title: "",
  artist: "",
  category: "conciertos",
  description: "",
  imageUrl: "",
  status: "draft",
  featured: false,
  urgencyNote: "",
  ageRestriction: "",
};

function AdminEvents() {
  const qc = useQueryClient();
  const events = useQuery({ queryKey: ["admin", "events"], queryFn: () => adminEvents() });
  const venues = useQuery({ queryKey: ["admin", "venues"], queryFn: () => adminVenues() });

  const [form, setForm] = useState<EventForm>(emptyEvent);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin"] });
  };

  const saveEvent = useMutation({
    mutationFn: () =>
      adminSaveEvent({
        data: {
          id: form.id,
          title: form.title,
          artist: form.artist || null,
          category: form.category,
          description: form.description || null,
          imageUrl: form.imageUrl || null,
          status: form.status,
          featured: form.featured,
          urgencyNote: form.urgencyNote || null,
          ageRestriction: form.ageRestriction || null,
        },
      }),
    onSuccess: () => {
      setForm(emptyEvent);
      setMessage("Evento guardado");
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const removeEvent = useMutation({
    mutationFn: (id: string) => adminDeleteEvent({ data: { id } }),
    onSuccess: refresh,
  });

  return (
    <div className="grid gap-12">
      <div>
        <Caption className="text-graphite">Catálogo</Caption>
        <DisplayHeading className="mt-3">Eventos</DisplayHeading>
      </div>

      <section className="grid gap-6 rounded-card bg-plaster p-7">
        <SectionTitle>{form.id ? "Editar evento" : "Nuevo evento"}</SectionTitle>
        <div className="grid gap-6 md:grid-cols-2">
          <Field label="Título">
            <TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Artista / elenco">
            <TextInput value={form.artist} onChange={(e) => setForm({ ...form, artist: e.target.value })} />
          </Field>
          <Field label="Categoría">
            <Select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as EventForm["category"] })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Estado">
            <Select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as EventForm["status"] })}
            >
              <option value="draft">Borrador</option>
              <option value="published">Publicado</option>
              <option value="soldout">Agotado</option>
              <option value="archived">Archivado</option>
            </Select>
          </Field>
          <Field label="Imagen (URL)">
            <TextInput value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} />
          </Field>
          <Field label="Nota de urgencia" hint="Ej: Últimas entradas Platea Baja">
            <TextInput
              value={form.urgencyNote}
              onChange={(e) => setForm({ ...form, urgencyNote: e.target.value })}
            />
          </Field>
          <Field label="Restricción de edad">
            <TextInput
              value={form.ageRestriction}
              onChange={(e) => setForm({ ...form, ageRestriction: e.target.value })}
            />
          </Field>
          <Field label="Destacado en portada">
            <Select
              value={form.featured ? "yes" : "no"}
              onChange={(e) => setForm({ ...form, featured: e.target.value === "yes" })}
            >
              <option value="no">No</option>
              <option value="yes">Sí</option>
            </Select>
          </Field>
        </div>
        <Field label="Descripción">
          <TextArea
            rows={4}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <PillButton onClick={() => saveEvent.mutate()} disabled={saveEvent.isPending || form.title.length < 2}>
            {saveEvent.isPending ? "Guardando…" : "Guardar evento"}
          </PillButton>
          {form.id ? <GhostButton onClick={() => setForm(emptyEvent)}>Cancelar edición</GhostButton> : null}
          {message ? <MetaText className="inline">{message}</MetaText> : null}
        </div>
      </section>

      <section className="grid gap-6">
        <SectionTitle>Eventos existentes</SectionTitle>
        <Hairline />
        {events.isLoading ? <MetaText>Cargando…</MetaText> : null}
        {(events.data ?? []).map((event) => (
          <div key={event.id} className="grid gap-4 border-b border-ash pb-6">
            <div className="flex flex-wrap items-center gap-6">
              <div className="grid gap-1">
                <span className="text-subheading">{event.title}</span>
                <MetaText>
                  {CATEGORY_LABELS[event.category]} · {event.status} ·{" "}
                  {(event.event_dates ?? []).length} fechas
                </MetaText>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-4">
                <GhostButton
                  arrow={false}
                  onClick={() =>
                    setForm({
                      id: event.id,
                      title: event.title,
                      artist: event.artist ?? "",
                      category: event.category,
                      description: event.description ?? "",
                      imageUrl: event.image_url ?? "",
                      status: event.status,
                      featured: event.featured,
                      urgencyNote: event.urgency_note ?? "",
                      ageRestriction: event.age_restriction ?? "",
                    })
                  }
                >
                  <span className="underline">Editar</span>
                </GhostButton>
                <GhostButton arrow={false} onClick={() => setOpenId(openId === event.id ? null : event.id)}>
                  <span className="underline">
                    {openId === event.id ? "Cerrar" : "Fechas y fila virtual"}
                  </span>
                </GhostButton>
                <GhostButton
                  arrow={false}
                  onClick={() => {
                    if (confirm(`¿Eliminar ${event.title}? Se borran fechas y tickets.`))
                      removeEvent.mutate(event.id);
                  }}
                >
                  <span className="text-ember underline">Eliminar</span>
                </GhostButton>
              </div>
            </div>

            {openId === event.id ? (
              <div className="grid gap-10 rounded-card bg-plaster p-6">
                <QueueEditor
                  eventId={event.id}
                  config={event.queue_config ?? null}
                  onDone={refresh}
                />
                <DatesEditor
                  eventId={event.id}
                  dates={event.event_dates ?? []}
                  venues={venues.data ?? []}
                  onDone={refresh}
                />
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}

type QueueConfig = {
  enabled: boolean;
  concurrent_slots: number;
  window_minutes: number;
  waiting_message: string | null;
  simulated_queue_size: number;
};

function QueueEditor({
  eventId,
  config,
  onDone,
}: {
  eventId: string;
  config: QueueConfig | null;
  onDone: () => void;
}) {
  const [state, setState] = useState({
    enabled: config?.enabled ?? false,
    concurrentSlots: config?.concurrent_slots ?? 200,
    windowMinutes: config?.window_minutes ?? 10,
    simulatedQueueSize: config?.simulated_queue_size ?? 1200,
    waitingMessage: config?.waiting_message ?? "",
  });

  const save = useMutation({
    mutationFn: () =>
      adminSaveQueue({
        data: {
          eventId,
          enabled: state.enabled,
          concurrentSlots: state.concurrentSlots,
          windowMinutes: state.windowMinutes,
          simulatedQueueSize: state.simulatedQueueSize,
          waitingMessage: state.waitingMessage || null,
        },
      }),
    onSuccess: onDone,
  });

  const reset = useMutation({
    mutationFn: () => adminResetQueue({ data: { eventId } }),
    onSuccess: onDone,
  });

  return (
    <div className="grid gap-6">
      <SectionTitle>Fila virtual</SectionTitle>
      <div className="grid gap-6 md:grid-cols-4">
        <Field label="Activada">
          <Select
            value={state.enabled ? "yes" : "no"}
            onChange={(e) => setState({ ...state, enabled: e.target.value === "yes" })}
          >
            <option value="no">No</option>
            <option value="yes">Sí</option>
          </Select>
        </Field>
        <Field label="Cupos simultáneos">
          <TextInput
            type="number"
            value={state.concurrentSlots}
            onChange={(e) => setState({ ...state, concurrentSlots: Number(e.target.value) })}
          />
        </Field>
        <Field label="Ventana de compra (min)">
          <TextInput
            type="number"
            value={state.windowMinutes}
            onChange={(e) => setState({ ...state, windowMinutes: Number(e.target.value) })}
          />
        </Field>
        <Field label="Tamaño de fila simulado">
          <TextInput
            type="number"
            value={state.simulatedQueueSize}
            onChange={(e) => setState({ ...state, simulatedQueueSize: Number(e.target.value) })}
          />
        </Field>
      </div>
      <Field label="Mensaje en sala de espera">
        <TextInput
          value={state.waitingMessage}
          onChange={(e) => setState({ ...state, waitingMessage: e.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <PillButton onClick={() => save.mutate()} disabled={save.isPending}>
          Guardar fila
        </PillButton>
        <OutlineButton onClick={() => reset.mutate()} disabled={reset.isPending}>
          Vaciar fila actual
        </OutlineButton>
      </div>
    </div>
  );
}

type AdminDate = {
  id: string;
  starts_at: string;
  doors_at: string | null;
  on_sale: boolean;
  venue_id: string;
  venues: { name: string; city: string } | null;
  ticket_types: {
    id: string;
    name: string;
    price: number | string;
    service_fee: number | string;
    capacity: number;
    sold: number;
    section_id: string;
  }[];
};

type AdminVenue = {
  id: string;
  name: string;
  city: string;
  venue_sections: { id: string; name: string; kind: string; capacity: number }[];
};

function DatesEditor({
  eventId,
  dates,
  venues,
  onDone,
}: {
  eventId: string;
  dates: AdminDate[];
  venues: AdminVenue[];
  onDone: () => void;
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? "");
  const [startsAt, setStartsAt] = useState("");
  const [doorsAt, setDoorsAt] = useState("");
  const [onSale, setOnSale] = useState(true);
  const [prices, setPrices] = useState<Record<string, { price: number; fee: number }>>({});
  const [error, setError] = useState<string | null>(null);

  const venue = venues.find((v) => v.id === venueId);

  const saveDate = useMutation({
    mutationFn: () =>
      adminSaveDate({
        data: {
          eventId,
          venueId,
          startsAt,
          doorsAt: doorsAt || null,
          onSale,
          prices: (venue?.venue_sections ?? []).map((section) => ({
            sectionId: section.id,
            name: section.name,
            price: prices[section.id]?.price ?? 0,
            fee: prices[section.id]?.fee ?? 0,
            capacity: section.capacity,
          })),
        },
      }),
    onSuccess: () => {
      setStartsAt("");
      setDoorsAt("");
      onDone();
    },
    onError: (e: Error) => setError(e.message),
  });

  const removeDate = useMutation({
    mutationFn: (id: string) => adminDeleteDate({ data: { id } }),
    onSuccess: onDone,
  });

  return (
    <div className="grid gap-6">
      <SectionTitle>Fechas, recinto y precios</SectionTitle>

      <div className="grid gap-4">
        {dates.length === 0 ? <MetaText>Este evento aún no tiene fechas.</MetaText> : null}
        {dates.map((date) => (
          <div key={date.id} className="grid gap-2 border-b border-ash pb-4">
            <div className="flex flex-wrap items-center gap-6">
              <span className="text-body">{dateAndTime(date.starts_at)}</span>
              <MetaText className="inline">
                {date.venues?.name} · {date.on_sale ? "En venta" : "Cerrada"}
              </MetaText>
              <GhostButton
                arrow={false}
                className="ml-auto"
                onClick={() => {
                  if (confirm("¿Eliminar esta fecha?")) removeDate.mutate(date.id);
                }}
              >
                <span className="text-ember underline">Eliminar</span>
              </GhostButton>
            </div>
            <div className="grid gap-1">
              {date.ticket_types.map((type) => (
                <MetaText key={type.id}>
                  {type.name}: {money(Number(type.price))} + {money(Number(type.service_fee))} ·{" "}
                  {type.sold}/{type.capacity} vendidos
                </MetaText>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Field label="Recinto">
          <Select value={venueId} onChange={(e) => setVenueId(e.target.value)}>
            <option value="">Selecciona</option>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {v.city}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Inicio del show">
          <TextInput
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </Field>
        <Field label="Apertura de puertas">
          <TextInput type="datetime-local" value={doorsAt} onChange={(e) => setDoorsAt(e.target.value)} />
        </Field>
        <Field label="En venta">
          <Select value={onSale ? "yes" : "no"} onChange={(e) => setOnSale(e.target.value === "yes")}>
            <option value="yes">Sí</option>
            <option value="no">No</option>
          </Select>
        </Field>
      </div>

      {venue ? (
        <div className="grid gap-4">
          <MetaText>Precio y cargo por sector de {venue.name}</MetaText>
          {venue.venue_sections.map((section) => (
            <div key={section.id} className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end">
              <MetaText className="inline">
                {section.name} ({section.kind === "seated" ? "numerado" : "general"}) · cap.{" "}
                {section.capacity}
              </MetaText>
              <Field label="Precio">
                <TextInput
                  type="number"
                  value={prices[section.id]?.price ?? 0}
                  onChange={(e) =>
                    setPrices((prev) => ({
                      ...prev,
                      [section.id]: {
                        price: Number(e.target.value),
                        fee: prev[section.id]?.fee ?? 0,
                      },
                    }))
                  }
                />
              </Field>
              <Field label="Cargo">
                <TextInput
                  type="number"
                  value={prices[section.id]?.fee ?? 0}
                  onChange={(e) =>
                    setPrices((prev) => ({
                      ...prev,
                      [section.id]: {
                        price: prev[section.id]?.price ?? 0,
                        fee: Number(e.target.value),
                      },
                    }))
                  }
                />
              </Field>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-body text-ember">
          {error}
        </p>
      ) : null}

      <div>
        <PillButton
          onClick={() => saveDate.mutate()}
          disabled={saveDate.isPending || !venueId || startsAt.length < 10}
        >
          Agregar fecha
        </PillButton>
      </div>
    </div>
  );
}
