import { AppError, type CLP, createEvent, newId } from "@shared/commons";
import { type Pool, type Queryable, enqueueOutbox, withTransaction } from "@shared/commons/db";
import type { ReadCache } from "../cache.js";
import type { MediaService } from "../media/service.js";
import {
  type Actor,
  assertCanManage,
  isAdmin,
  isUniqueViolation,
  money,
  uniqueSlug,
} from "../shared.js";

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface ProductDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sku: string | null;
  price: string;
  fee: string;
  imageId: string | null;
  imageUrl: string | null;
  eventId: string | null;
  status: ProductStatus;
  maxPerOrder: number;
  ownerId: string | null;
}

export type PublicProductDto = Omit<ProductDto, "ownerId" | "imageId" | "status">;

export interface ProductInput {
  name: string;
  description: string | null;
  sku: string | null;
  price: CLP;
  fee: CLP;
  imageId: string | null;
  eventId: string | null;
  status: ProductStatus;
  maxPerOrder: number;
}

export interface ProductService {
  listPublic(query: { eventId?: string | undefined }): Promise<PublicProductDto[]>;
  getPublic(slug: string): Promise<PublicProductDto>;
  listForAdmin(actor: Actor): Promise<ProductDto[]>;
  create(actor: Actor, input: ProductInput, correlationId?: string): Promise<ProductDto>;
  update(
    actor: Actor,
    id: string,
    input: ProductInput,
    correlationId?: string,
  ): Promise<ProductDto>;
  remove(actor: Actor, id: string, correlationId?: string): Promise<void>;
}

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sku: string | null;
  price: bigint;
  service_fee: bigint;
  image_id: string | null;
  event_id: string | null;
  status: ProductStatus;
  max_per_order: number;
  owner_id: string | null;
}

const SERVICE_SOURCE = "catalog";

export function createProductService(options: {
  pool: Pool;
  cache: ReadCache;
  media: Pick<MediaService, "url">;
}): ProductService {
  const { pool, cache, media } = options;

  function toDto(row: ProductRow): ProductDto {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      sku: row.sku,
      price: money(row.price),
      fee: money(row.service_fee),
      imageId: row.image_id,
      imageUrl: row.image_id ? media.url(row.image_id) : null,
      eventId: row.event_id,
      status: row.status,
      maxPerOrder: row.max_per_order,
      ownerId: row.owner_id,
    };
  }

  function toPublic(product: ProductDto): PublicProductDto {
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      description: product.description,
      sku: product.sku,
      price: product.price,
      fee: product.fee,
      imageUrl: product.imageUrl,
      eventId: product.eventId,
      maxPerOrder: product.maxPerOrder,
    };
  }

  async function lockProduct(db: Queryable, actor: Actor, id: string): Promise<ProductRow> {
    const result = await db.query<ProductRow>("select * from products where id = $1 for update", [
      id,
    ]);
    const row = result.rows[0];
    if (!row) throw AppError.notFound("El producto no existe");
    assertCanManage(actor, row.owner_id);
    return row;
  }

  async function validateReferences(db: Queryable, input: ProductInput) {
    if (input.imageId) {
      const image = await db.query("select 1 from media where id = $1", [input.imageId]);
      if ((image.rowCount ?? 0) === 0) {
        throw AppError.validation([{ path: "imageId", message: "La imagen no existe" }]);
      }
    }
    if (input.eventId) {
      const event = await db.query("select 1 from events where id = $1", [input.eventId]);
      if ((event.rowCount ?? 0) === 0) {
        throw AppError.validation([{ path: "eventId", message: "El evento no existe" }]);
      }
    }
  }

  async function enqueue(db: Queryable, product: ProductDto, correlationId?: string) {
    await enqueueOutbox(
      db,
      createEvent({
        type: "ProductoActualizado",
        source: SERVICE_SOURCE,
        aggregateId: product.id,
        correlationId,
        data: {
          productId: product.id,
          slug: product.slug,
          name: product.name,
          status: product.status,
          price: product.price,
          fee: product.fee,
          eventId: product.eventId,
          ownerId: product.ownerId,
        },
      }),
    );
  }

  function skuConflict(error: unknown): never {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("SKU_TAKEN", "Ya existe un producto con ese SKU");
    }
    throw error;
  }

  return {
    async listPublic(query) {
      const all = await cache.get("products:public", async () => {
        const result = await pool.query<ProductRow>(
          "select * from products where status = 'active' order by name",
        );
        return result.rows.map((row) => toPublic(toDto(row)));
      });
      return query.eventId ? all.filter((product) => product.eventId === query.eventId) : all;
    },

    async getPublic(slug) {
      const product = await cache.get(`product:${slug}`, async () => {
        const result = await pool.query<ProductRow>(
          "select * from products where slug = $1 and status = 'active'",
          [slug],
        );
        const row = result.rows[0];
        return row ? toPublic(toDto(row)) : null;
      });
      if (!product) throw AppError.notFound("El producto no existe");
      return product;
    },

    async listForAdmin(actor) {
      const result = isAdmin(actor)
        ? await pool.query<ProductRow>("select * from products order by created_at desc")
        : await pool.query<ProductRow>(
            "select * from products where owner_id = $1 order by created_at desc",
            [actor.id],
          );
      return result.rows.map(toDto);
    },

    async create(actor, input, correlationId) {
      const product = await withTransaction(pool, async (client) => {
        await validateReferences(client, input);
        const id = newId();
        const ownerId = isAdmin(actor) ? null : actor.id;
        let row: ProductRow | undefined;
        for (let attempt = 0; !row; attempt += 1) {
          try {
            await client.query("savepoint slug");
            const result = await client.query<ProductRow>(
              `insert into products (id, slug, name, description, sku, price, service_fee, image_id,
                 event_id, status, max_per_order, owner_id)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
              [
                id,
                uniqueSlug(input.name),
                input.name,
                input.description,
                input.sku,
                input.price,
                input.fee,
                input.imageId,
                input.eventId,
                input.status,
                input.maxPerOrder,
                ownerId,
              ],
            );
            row = result.rows[0];
          } catch (error) {
            await client.query("rollback to savepoint slug");
            const slugCollision =
              isUniqueViolation(error) &&
              (error as { constraint?: string }).constraint === "products_slug_key";
            if (!slugCollision || attempt >= 2) skuConflict(error);
          }
        }
        const dto = toDto(row);
        await enqueue(client, dto, correlationId);
        return dto;
      });
      await cache.invalidate();
      return product;
    },

    async update(actor, id, input, correlationId) {
      const product = await withTransaction(pool, async (client) => {
        await lockProduct(client, actor, id);
        await validateReferences(client, input);
        let row: ProductRow;
        try {
          const result = await client.query<ProductRow>(
            `update products set name = $2, description = $3, sku = $4, price = $5,
               service_fee = $6, image_id = $7, event_id = $8, status = $9, max_per_order = $10,
               updated_at = now()
             where id = $1 returning *`,
            [
              id,
              input.name,
              input.description,
              input.sku,
              input.price,
              input.fee,
              input.imageId,
              input.eventId,
              input.status,
              input.maxPerOrder,
            ],
          );
          row = result.rows[0]!;
        } catch (error) {
          skuConflict(error);
        }
        const dto = toDto(row);
        await enqueue(client, dto, correlationId);
        return dto;
      });
      await cache.invalidate();
      return product;
    },

    async remove(actor, id, correlationId) {
      await withTransaction(pool, async (client) => {
        await lockProduct(client, actor, id);
        await client.query("delete from products where id = $1", [id]);
        await enqueueOutbox(
          client,
          createEvent({
            type: "ProductoEliminado",
            source: SERVICE_SOURCE,
            aggregateId: id,
            correlationId,
            data: { productId: id },
          }),
        );
      });
      await cache.invalidate();
    },
  };
}
