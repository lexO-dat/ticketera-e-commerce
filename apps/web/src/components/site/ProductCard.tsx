import { Link } from "@tanstack/react-router";

import { MetaText, SectionTitle } from "@/components/kit/Text";
import type { CatalogProduct } from "@/lib/catalog.functions";
import { money } from "@/lib/format";

export function ProductCard({ product }: { product: CatalogProduct }) {
  return (
    <Link
      to="/tienda/$slug"
      params={{ slug: product.slug }}
      className="group grid gap-4"
      aria-label={product.name}
    >
      <div className="relative aspect-square overflow-hidden rounded-card bg-plaster">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.name}
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center font-roboto text-caption uppercase tracking-[0.14em] text-graphite">
            {product.name.split(" ")[0]}
          </span>
        )}
      </div>
      <div className="grid gap-1">
        <SectionTitle as="h3" className="text-subheading">
          {product.name}
        </SectionTitle>
        {product.description ? (
          <MetaText className="line-clamp-2">{product.description}</MetaText>
        ) : null}
        <span className="mt-1 text-body">{money(product.price + product.fee)}</span>
      </div>
    </Link>
  );
}
