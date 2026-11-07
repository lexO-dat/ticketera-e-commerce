# ADR-09 · Imágenes del catálogo en Postgres, re-codificadas y cacheadas en el borde

- **Estado:** Aceptado · **ASR:** ASR01 Disponibilidad, ASR04 Seguridad · Complementa ADR-02

## Contexto

El prototipo enlazaba imágenes del CDN de Lovable. `AGENTS.md` pedía reemplazarlo con un módulo
**media** propio "sobre volumen o MinIO self-hosted". Con `catalog` corriendo en varias réplicas
(ADR-01), un volumen local no se comparte entre zonas y MinIO agrega otro sistema con estado que
replicar y respaldar.

Las imágenes del catálogo son pocas (portadas de eventos y productos), pequeñas una vez
re-codificadas (decenas a cientos de KB) e inmutables.

## Decisión

- Las imágenes se guardan en la base de `catalog` (`bytea`), así quedan en la réplica síncrona con
  el resto del catálogo y sobreviven al failover sin almacenamiento compartido.
- Toda subida se decodifica y vuelve a codificar como WebP (máx. 2400 px, sin metadatos) con
  `sharp`. Se rechaza lo que no sea JPEG, PNG, WebP, AVIF o GIF por su contenido real, y se limita
  el número de píxeles al decodificar.
- El id de una imagen nunca cambia de contenido: se sirve con `Cache-Control: immutable` y ETag,
  y Nginx la cachea en el borde (`proxy_cache`, con `proxy_cache_lock`). Postgres solo atiende la
  primera descarga de cada imagen por nodo de borde.
- El acceso queda detrás de una interfaz (`MediaService`) para poder moverlo a almacenamiento de
  objetos self-hosted sin tocar el resto del servicio.

## Consecuencias

- (+) Sin un sistema nuevo que operar; respaldo y failover son los de Postgres.
- (+) Una imagen maliciosa (políglota, EXIF con GPS, SVG con script) no llega a los navegadores.
- (−) La base crece con las imágenes; aceptable al volumen esperado. Si el catálogo pasa a miles de
  imágenes grandes, se migra a almacenamiento de objetos (nuevo ADR).
- (−) No hay URLs firmadas: las imágenes del catálogo son públicas por naturaleza. Los archivos
  privados (si aparecen) necesitarán otro mecanismo.
