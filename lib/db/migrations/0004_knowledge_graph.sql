CREATE TYPE "public"."graph_node_kind" AS ENUM('product', 'protocol', 'vendor', 'device', 'concept', 'destination', 'category');--> statement-breakpoint
CREATE TYPE "public"."graph_relation" AS ENUM('speaks', 'compatible_with', 'in_category', 'alias_of', 'writes_to', 'related_to');--> statement-breakpoint
CREATE TABLE "graph_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"relation" "graph_relation" NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "graph_node_kind" NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"product_id" uuid
);
--> statement-breakpoint
-- Removed by hand: drizzle-kit emitted a drop and re-add of products.search_vector
-- here, because migration 0003 was written by hand and its snapshot still
-- described the older five-argument function. The column is already correct
-- after 0003, and dropping it would take the GIN index with it and never
-- rebuild it -- turning every BM25 query into a sequential scan on any
-- database that migrates forward. The integration test on products_fts_idx
-- caught this.
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_from_id_graph_nodes_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_to_id_graph_nodes_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_edges_triple_uq" ON "graph_edges" USING btree ("from_id","to_id","relation");--> statement-breakpoint
CREATE INDEX "graph_edges_from_idx" ON "graph_edges" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "graph_edges_to_idx" ON "graph_edges" USING btree ("to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_kind_key_uq" ON "graph_nodes" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "graph_nodes_kind_idx" ON "graph_nodes" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "graph_nodes_product_idx" ON "graph_nodes" USING btree ("product_id");