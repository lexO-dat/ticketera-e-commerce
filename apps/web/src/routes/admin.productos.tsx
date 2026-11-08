import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillButton } from "@/components/kit/PillButton";
import { Field, Select, TextArea, TextInput } from "@/components/kit/Field";
import { ImageUpload } from "@/components/kit/ImageUpload";
import {
  adminDeleteProduct,
  adminEvents,
  adminProducts,
  adminSaveProduct,
  type AdminProduct,
} from "@/lib/admin.functions";
import { money } from "@/lib/format";

export const Route = createFileRoute("/admin/productos")({
  component: AdminProductsPage,
});

type ProductForm = {
  id: string | null;
  name: string;
  description: string;
  sku: string;
  price: number;
  fee: number;
  imageId: string | null;
  imageUrl: string | null;
  eventId: string;
  status: AdminProduct["status"];
  maxPerOrder: number;
};

const empty: ProductForm = {
  id: null,
  name: "",
  description: "",
  sku: "",
  price: 0,
  fee: 0,
  imageId: null,
  imageUrl: null,
  eventId: "",
  status: "draft",
  maxPerOrder: 10,
};

const STATUS_LABELS: Record<AdminProduct["status"], string> = {
  draft: "Borrador",
  active: "Activo",
  archived: "Archivado",
};

/** Productos (RF03, RF14): merchandising y otros `ItemVendible` del catálogo. */
function AdminProductsPage() {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ["admin", "products"], queryFn: () => adminProducts() });
  const events = useQuery({ queryKey: ["admin", "events"], queryFn: () => adminEvents() });
  const [form, setForm] = useState<ProductForm>(empty);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin"] });
  };

  const save = useMutation({
    mutationFn: () =>
      adminSaveProduct({
        data: {
          id: form.id,
          name: form.name,
          description: form.description || null,
          sku: form.sku || null,
          price: form.price,
          fee: form.fee,
          imageId: form.imageId,
          eventId: form.eventId || null,
          status: form.status,
          maxPerOrder: form.maxPerOrder,
        },
      }),
    onSuccess: () => {
      setForm(empty);
      setMessage("Producto guardado");
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminDeleteProduct({ data: { id } }),
    onSuccess: refresh,
  });

  const eventTitle = (id: string | null) =>
    id ? ((events.data ?? []).find((event) => event.id === id)?.title ?? "Evento") : null;

  return (
    <div className="grid gap-10">
      <div>
        <Caption className="text-graphite">Catálogo</Caption>
        <DisplayHeading className="mt-3">Productos</DisplayHeading>
      </div>

      <section className="grid gap-6 rounded-card bg-plaster p-7">
        <SectionTitle>{form.id ? "Editar producto" : "Nuevo producto"}</SectionTitle>
        <div className="grid gap-6 md:grid-cols-3">
          <Field label="Nombre">
            <TextInput
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="SKU" hint="Opcional, único">
            <TextInput
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
            />
          </Field>
          <Field label="Estado">
            <Select
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value as ProductForm["status"] })
              }
            >
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Precio (CLP)">
            <TextInput
              type="number"
              min={0}
              step={1}
              value={form.price}
              onChange={(e) => setForm({ ...form, price: Math.trunc(Number(e.target.value)) })}
            />
          </Field>
          <Field label="Cargo por servicio (CLP)">
            <TextInput
              type="number"
              min={0}
              step={1}
              value={form.fee}
              onChange={(e) => setForm({ ...form, fee: Math.trunc(Number(e.target.value)) })}
            />
          </Field>
          <Field label="Máximo por compra">
            <TextInput
              type="number"
              min={1}
              max={100}
              value={form.maxPerOrder}
              onChange={(e) =>
                setForm({ ...form, maxPerOrder: Math.trunc(Number(e.target.value)) })
              }
            />
          </Field>
          <Field label="Evento asociado" hint="Opcional: merchandising del evento">
            <Select
              value={form.eventId}
              onChange={(e) => setForm({ ...form, eventId: e.target.value })}
            >
              <option value="">Ninguno</option>
              {(events.data ?? []).map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Imagen">
            <ImageUpload
              imageUrl={form.imageUrl}
              onChange={(image) =>
                setForm({ ...form, imageId: image?.id ?? null, imageUrl: image?.url ?? null })
              }
            />
          </Field>
        </div>
        <Field label="Descripción">
          <TextArea
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <PillButton
            onClick={() => save.mutate()}
            disabled={save.isPending || form.name.length < 2}
          >
            {save.isPending ? "Guardando…" : "Guardar producto"}
          </PillButton>
          {form.id ? <GhostButton onClick={() => setForm(empty)}>Cancelar</GhostButton> : null}
          {message ? <MetaText className="inline">{message}</MetaText> : null}
        </div>
      </section>

      <section className="grid gap-4">
        <SectionTitle>Productos existentes</SectionTitle>
        <Hairline />
        {products.isLoading ? <MetaText>Cargando…</MetaText> : null}
        {products.data?.length === 0 ? <MetaText>Aún no hay productos.</MetaText> : null}
        {(products.data ?? []).map((product) => (
          <div
            key={product.id}
            className="grid gap-3 border-b border-ash pb-4 md:grid-cols-[1fr_auto_auto_auto] md:items-center md:gap-6"
          >
            <div className="grid gap-1">
              <span className="text-body">{product.name}</span>
              <MetaText>
                {STATUS_LABELS[product.status]}
                {product.sku ? ` · ${product.sku}` : ""}
                {product.eventId ? ` · ${eventTitle(product.eventId)}` : ""}
              </MetaText>
            </div>
            <span className="text-body">{money(Number(product.price))}</span>
            <GhostButton
              arrow={false}
              onClick={() =>
                setForm({
                  id: product.id,
                  name: product.name,
                  description: product.description ?? "",
                  sku: product.sku ?? "",
                  price: Number(product.price),
                  fee: Number(product.fee),
                  imageId: product.imageId,
                  imageUrl: product.imageUrl,
                  eventId: product.eventId ?? "",
                  status: product.status,
                  maxPerOrder: product.maxPerOrder,
                })
              }
            >
              <span className="underline">Editar</span>
            </GhostButton>
            <GhostButton
              arrow={false}
              onClick={() => {
                if (confirm(`¿Eliminar ${product.name}?`)) remove.mutate(product.id);
              }}
            >
              <span className="text-ember underline">Eliminar</span>
            </GhostButton>
          </div>
        ))}
      </section>
    </div>
  );
}
