import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillButton } from "@/components/kit/PillButton";
import { Field, Select, TextInput } from "@/components/kit/Field";
import {
  adminDeleteSection,
  adminSaveSection,
  adminSaveVenue,
  adminVenues,
} from "@/lib/admin.functions";
import { plainNumber } from "@/lib/format";

export const Route = createFileRoute("/admin/recintos")({
  component: AdminVenuesPage,
});

const emptyVenue = { id: null as string | null, name: "", city: "", address: "", capacity: 0 };

const emptySection = {
  id: null as string | null,
  name: "",
  kind: "seated" as "seated" | "general",
  capacity: 0,
  sortOrder: 0,
  x: 100,
  y: 120,
  w: 320,
  h: 200,
  seatRows: 8,
  seatsPerRow: 12,
  regenerateSeats: false,
};

function AdminVenuesPage() {
  const qc = useQueryClient();
  const venues = useQuery({ queryKey: ["admin", "venues"], queryFn: () => adminVenues() });
  const [venueForm, setVenueForm] = useState(emptyVenue);
  const [activeVenue, setActiveVenue] = useState<string | null>(null);
  const [sectionForm, setSectionForm] = useState(emptySection);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin"] });
  };

  const saveVenue = useMutation({
    mutationFn: () =>
      adminSaveVenue({
        data: {
          id: venueForm.id,
          name: venueForm.name,
          city: venueForm.city,
          address: venueForm.address || null,
          capacity: venueForm.capacity,
        },
      }),
    onSuccess: () => {
      setVenueForm(emptyVenue);
      setMessage("Recinto guardado");
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const saveSection = useMutation({
    mutationFn: (venueId: string) =>
      adminSaveSection({
        data: {
          id: sectionForm.id,
          venueId,
          name: sectionForm.name,
          kind: sectionForm.kind,
          capacity: sectionForm.kind === "general" ? sectionForm.capacity : 0,
          sortOrder: sectionForm.sortOrder,
          x: sectionForm.x,
          y: sectionForm.y,
          w: sectionForm.w,
          h: sectionForm.h,
          seatRows: sectionForm.kind === "seated" ? sectionForm.seatRows : 0,
          seatsPerRow: sectionForm.kind === "seated" ? sectionForm.seatsPerRow : 0,
          regenerateSeats: sectionForm.regenerateSeats,
        },
      }),
    onSuccess: () => {
      setSectionForm(emptySection);
      setMessage("Sector guardado");
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const removeSection = useMutation({
    mutationFn: (id: string) => adminDeleteSection({ data: { id } }),
    onSuccess: refresh,
  });

  return (
    <div className="grid gap-12">
      <div>
        <Caption className="text-graphite">Infraestructura</Caption>
        <DisplayHeading className="mt-3">Recintos y mapas</DisplayHeading>
      </div>

      <section className="grid gap-6 rounded-card bg-plaster p-7">
        <SectionTitle>{venueForm.id ? "Editar recinto" : "Nuevo recinto"}</SectionTitle>
        <div className="grid gap-6 md:grid-cols-4">
          <Field label="Nombre">
            <TextInput
              value={venueForm.name}
              onChange={(e) => setVenueForm({ ...venueForm, name: e.target.value })}
            />
          </Field>
          <Field label="Ciudad">
            <TextInput
              value={venueForm.city}
              onChange={(e) => setVenueForm({ ...venueForm, city: e.target.value })}
            />
          </Field>
          <Field label="Dirección">
            <TextInput
              value={venueForm.address}
              onChange={(e) => setVenueForm({ ...venueForm, address: e.target.value })}
            />
          </Field>
          <Field label="Capacidad total">
            <TextInput
              type="number"
              value={venueForm.capacity}
              onChange={(e) => setVenueForm({ ...venueForm, capacity: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <PillButton
            onClick={() => saveVenue.mutate()}
            disabled={saveVenue.isPending || venueForm.name.length < 2 || venueForm.city.length < 2}
          >
            Guardar recinto
          </PillButton>
          {venueForm.id ? (
            <GhostButton onClick={() => setVenueForm(emptyVenue)}>Cancelar</GhostButton>
          ) : null}
          {message ? <MetaText className="inline">{message}</MetaText> : null}
        </div>
      </section>

      <section className="grid gap-6">
        <SectionTitle>Recintos</SectionTitle>
        <Hairline />
        {venues.isLoading ? <MetaText>Cargando…</MetaText> : null}
        {(venues.data ?? []).map((venue) => (
          <div key={venue.id} className="grid gap-4 border-b border-ash pb-6">
            <div className="flex flex-wrap items-center gap-6">
              <div className="grid gap-1">
                <span className="text-subheading">{venue.name}</span>
                <MetaText>
                  {venue.city} · capacidad {plainNumber(venue.capacity)} ·{" "}
                  {(venue.venue_sections ?? []).length} sectores
                </MetaText>
              </div>
              <div className="ml-auto flex items-center gap-4">
                <GhostButton
                  arrow={false}
                  onClick={() =>
                    setVenueForm({
                      id: venue.id,
                      name: venue.name,
                      city: venue.city,
                      address: venue.address ?? "",
                      capacity: venue.capacity,
                    })
                  }
                >
                  <span className="underline">Editar</span>
                </GhostButton>
                <GhostButton
                  arrow={false}
                  onClick={() => setActiveVenue(activeVenue === venue.id ? null : venue.id)}
                >
                  <span className="underline">
                    {activeVenue === venue.id ? "Cerrar sectores" : "Sectores y butacas"}
                  </span>
                </GhostButton>
              </div>
            </div>

            {activeVenue === venue.id ? (
              <div className="grid gap-8 rounded-card bg-plaster p-6">
                <div className="grid gap-3">
                  {(venue.venue_sections ?? []).map((section) => (
                    <div
                      key={section.id}
                      className="flex flex-wrap items-center gap-6 border-b border-ash pb-3"
                    >
                      <span className="text-body">{section.name}</span>
                      <MetaText className="inline">
                        {section.kind === "seated" ? "Numerado" : "General"} · cap.{" "}
                        {plainNumber(section.capacity)}
                      </MetaText>
                      <div className="ml-auto flex items-center gap-4">
                        <GhostButton
                          arrow={false}
                          onClick={() =>
                            setSectionForm({
                              id: section.id,
                              name: section.name,
                              kind: section.kind as "seated" | "general",
                              capacity: section.capacity,
                              sortOrder: section.sort_order,
                              x: section.shape_x,
                              y: section.shape_y,
                              w: section.shape_w,
                              h: section.shape_h,
                              seatRows: 8,
                              seatsPerRow: 12,
                              regenerateSeats: false,
                            })
                          }
                        >
                          <span className="underline">Editar</span>
                        </GhostButton>
                        <GhostButton
                          arrow={false}
                          onClick={() => {
                            if (confirm("¿Eliminar sector y sus butacas?"))
                              removeSection.mutate(section.id);
                          }}
                        >
                          <span className="text-ember underline">Eliminar</span>
                        </GhostButton>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid gap-6">
                  <SectionTitle>{sectionForm.id ? "Editar sector" : "Nuevo sector"}</SectionTitle>
                  <div className="grid gap-6 md:grid-cols-4">
                    <Field label="Nombre del sector">
                      <TextInput
                        value={sectionForm.name}
                        onChange={(e) => setSectionForm({ ...sectionForm, name: e.target.value })}
                      />
                    </Field>
                    <Field label="Tipo">
                      <Select
                        value={sectionForm.kind}
                        onChange={(e) =>
                          setSectionForm({
                            ...sectionForm,
                            kind: e.target.value as "seated" | "general",
                          })
                        }
                      >
                        <option value="seated">Numerado (butacas)</option>
                        <option value="general">General (sin numerar)</option>
                      </Select>
                    </Field>
                    <Field label="Orden">
                      <TextInput
                        type="number"
                        value={sectionForm.sortOrder}
                        onChange={(e) =>
                          setSectionForm({ ...sectionForm, sortOrder: Number(e.target.value) })
                        }
                      />
                    </Field>
                    {sectionForm.kind === "general" ? (
                      <Field label="Capacidad">
                        <TextInput
                          type="number"
                          value={sectionForm.capacity}
                          onChange={(e) =>
                            setSectionForm({ ...sectionForm, capacity: Number(e.target.value) })
                          }
                        />
                      </Field>
                    ) : (
                      <Field
                        label="Filas × asientos"
                        {...(sectionForm.id
                          ? { hint: "Al editar, las butacas solo se regeneran si lo marcas abajo." }
                          : {})}
                      >
                        <div className="flex gap-3">
                          <TextInput
                            type="number"
                            value={sectionForm.seatRows}
                            onChange={(e) =>
                              setSectionForm({ ...sectionForm, seatRows: Number(e.target.value) })
                            }
                          />
                          <TextInput
                            type="number"
                            value={sectionForm.seatsPerRow}
                            onChange={(e) =>
                              setSectionForm({
                                ...sectionForm,
                                seatsPerRow: Number(e.target.value),
                              })
                            }
                          />
                        </div>
                        {sectionForm.id ? (
                          <label className="mt-3 flex items-center gap-2 text-body">
                            <input
                              type="checkbox"
                              checked={sectionForm.regenerateSeats}
                              onChange={(e) =>
                                setSectionForm({
                                  ...sectionForm,
                                  regenerateSeats: e.target.checked,
                                })
                              }
                            />
                            Regenerar butacas (no se permite si el sector ya tiene entradas)
                          </label>
                        ) : null}
                      </Field>
                    )}
                  </div>

                  <div className="grid gap-6 md:grid-cols-4">
                    {(["x", "y", "w", "h"] as const).map((key) => (
                      <Field key={key} label={`Posición ${key.toUpperCase()}`}>
                        <TextInput
                          type="number"
                          value={sectionForm[key]}
                          onChange={(e) =>
                            setSectionForm({ ...sectionForm, [key]: Number(e.target.value) })
                          }
                        />
                      </Field>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <PillButton
                      onClick={() => saveSection.mutate(venue.id)}
                      disabled={saveSection.isPending || sectionForm.name.length < 1}
                    >
                      Guardar sector
                    </PillButton>
                    {sectionForm.id ? (
                      <GhostButton onClick={() => setSectionForm(emptySection)}>
                        Cancelar
                      </GhostButton>
                    ) : null}
                    <MetaText className="inline">
                      Las butacas se regeneran automáticamente al guardar un sector numerado.
                    </MetaText>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}
