-- Product specs carry the facts buyers ask compatibility questions about --
-- "SAML, OIDC", "hot standby", "restart, failover, notify" -- but only the
-- spec keys were reaching the index, so a query for single sign-on retrieved
-- nothing. Indexing the values closes that gap.
--
-- A generated column cannot have its expression altered in place, so the
-- column and its index are dropped and rebuilt around the new function.
DROP INDEX IF EXISTS "products_fts_idx";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "search_vector";--> statement-breakpoint
DROP FUNCTION IF EXISTS tagbridge_product_search_text(text, text, text, text[], text[]);--> statement-breakpoint
CREATE OR REPLACE FUNCTION tagbridge_product_search_text(
  p_name text,
  p_sku text,
  p_description text,
  p_protocols text[],
  p_vendor_compat text[],
  p_specs jsonb
) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('english', coalesce(p_name, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p_sku, '')), 'A')
      || setweight(to_tsvector('english', replace(coalesce(p_sku, ''), '-', ' ')), 'A')
      || setweight(to_tsvector('english', array_to_string(coalesce(p_protocols, '{}'), ' ')), 'B')
      || setweight(to_tsvector('english', array_to_string(coalesce(p_vendor_compat, '{}'), ' ')), 'B')
      || setweight(
           to_tsvector(
             'english',
             coalesce(
               (select string_agg(key || ' ' || value, ' ')
                from jsonb_each_text(coalesce(p_specs, '{}'::jsonb))),
               ''
             )
           ),
           'B'
         )
      || setweight(to_tsvector('english', coalesce(p_description, '')), 'C')
$$;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "search_vector" "tsvector"
  GENERATED ALWAYS AS (
    tagbridge_product_search_text(name, sku, description, protocols, vendor_compat, specs)
  ) STORED;--> statement-breakpoint
CREATE INDEX "products_fts_idx" ON "products" USING gin ("search_vector");
