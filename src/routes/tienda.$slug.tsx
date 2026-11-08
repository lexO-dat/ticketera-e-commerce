import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { Field, Select } from "@/components/kit/Field";
import { PillButton } from "@/components/kit/PillButton";
import { getProduct } from "@/lib/catalog.functions";
import { addToCart, productCartItem, useCart } from "@/lib/cart";
import { money } from "@/lib/format";
import { useAuth } from "@/lib/useAuth";

/** El carro acepta hasta 8 unidades por línea (orders); el producto puede fijar menos. */
const CART_LINE_MAX = 8;

const productQuery = (slug: string) =>
  queryOptions({
    queryKey: ["products", "detail", slug],
    queryFn: async () => {
      const data = await getProduct({ data: { slug } });
      if (!data) throw notFound();
      return data;
    },
  });

export const Route = createFileRoute("/tienda/$slug")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(productQuery(params.slug)),
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Producto — Ticketera" }] };
    const title = `${loaderData.name} — Tienda Ticketera`;
    const description = loaderData.description ?? "Producto oficial en la tienda de Ticketera.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        ...(loaderData.imageUrl ? [{ property: "og:image", content: loaderData.imageUrl }] : []),
      ],
    };
  },
  component: ProductPage,
  notFoundComponent: () => (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
        <SectionTitle>Este producto no está disponible</SectionTitle>
        <MetaText className="mt-3">
          <Link to="/tienda" className="underline">
            Volver a la tienda
          </Link>
        </MetaText>
      </div>
    </PublicLayout>
  ),
});

function ProductPage() {
  const { slug } = Route.useParams();
  const { data: product } = useSuspenseQuery(productQuery(slug));
  const { session } = useAuth();
  const { items } = useCart();
  const navigate = useNavigate();
  const inCart = items.find((item) => item.itemId === product.id)?.quantity ?? 0;
  const max = Math.max(1, Math.min(product.maxPerOrder, CART_LINE_MAX));
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!session) {
      void navigate({ to: "/auth", search: { redirect: `/tienda/${slug}` } });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // La línea es una sola por producto: se suma a lo que ya había, con el tope por orden.
      await addToCart([productCartItem(product, Math.min(max, inCart + quantity))]);
      void navigate({ to: "/carro" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos agregarlo al carro");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-14 md:grid-cols-2 md:px-8 md:py-20">
        <div className="relative aspect-square overflow-hidden rounded-card bg-plaster">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt={product.name} className="size-full object-cover" />
          ) : null}
        </div>

        <div className="grid content-start gap-6">
          <MetaText>
            <Link to="/tienda" className="underline">
              Tienda
            </Link>
          </MetaText>
          <DisplayHeading>{product.name}</DisplayHeading>
          {product.description ? <MetaText>{product.description}</MetaText> : null}
          <Hairline />
          <div className="flex items-baseline justify-between">
            <span className="text-subheading">{money(product.price)}</span>
            {product.fee > 0 ? (
              <MetaText className="inline">+ {money(product.fee)} de cargo por servicio</MetaText>
            ) : null}
          </div>

          <Field label="Cantidad">
            <Select
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              disabled={inCart >= max}
            >
              {Array.from({ length: Math.max(1, max - inCart) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>

          {error ? (
            <p role="alert" className="text-body text-ember">
              {error}
            </p>
          ) : null}

          <PillButton onClick={() => void add()} disabled={busy || inCart >= max}>
            {busy
              ? "Agregando…"
              : inCart >= max
                ? "Máximo por orden en tu carro"
                : "Agregar al carro"}
          </PillButton>
          <MetaText>
            {inCart > 0 ? `Ya tienes ${inCart} en tu carro. ` : ""}
            Máximo {max} por orden. Se paga junto con tus entradas en Webpay.
          </MetaText>
        </div>
      </div>
    </PublicLayout>
  );
}
