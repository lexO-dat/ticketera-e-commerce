import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";

import { PublicLayout } from "@/components/site/PublicLayout";
import { ProductCard } from "@/components/site/ProductCard";
import { DisplayHeading, MetaText, SectionTitle } from "@/components/kit/Text";
import { listProducts } from "@/lib/catalog.functions";

export const productsQuery = (eventId?: string) =>
  queryOptions({
    queryKey: ["products", "list", eventId ?? null],
    queryFn: () => listProducts({ data: eventId ? { eventId } : {} }),
  });

export const Route = createFileRoute("/tienda/")({
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(productsQuery());
  },
  head: () => ({
    meta: [
      { title: "Tienda — Ticketera" },
      {
        name: "description",
        content: "Poleras, vinilos y más de tus artistas y festivales favoritos.",
      },
      { property: "og:title", content: "Tienda — Ticketera" },
      { property: "og:description", content: "Productos oficiales de los eventos en cartelera." },
    ],
  }),
  component: StorePage,
  errorComponent: ({ error }) => (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8" role="alert">
        <SectionTitle>No pudimos cargar la tienda</SectionTitle>
        <MetaText className="mt-3">
          {error instanceof Error ? error.message : String(error)}
        </MetaText>
      </div>
    </PublicLayout>
  ),
});

function StorePage() {
  const { data: products } = useSuspenseQuery(productsQuery());

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-14 md:px-8 md:py-20">
        <DisplayHeading>Tienda</DisplayHeading>
        <MetaText className="mt-4">
          Productos oficiales de los eventos. Se pagan junto con tus entradas o por separado.
        </MetaText>
        <div aria-hidden className="mt-10 h-px w-full bg-carbon" />

        {products.length === 0 ? (
          <div className="py-20">
            <SectionTitle>Aún no hay productos</SectionTitle>
            <MetaText className="mt-3">Vuelve pronto.</MetaText>
          </div>
        ) : (
          <div className="mt-10 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
