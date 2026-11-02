-- Remove the derived systems: gardening jobs, card embeddings, the advisory card
-- graph, task retrieval and the derived-pool budget. Sources, receipts, TPS and the
-- two frozen usage ledgers (gardening_usage, derivation_usage) stay; spend totals
-- still read the ledgers. Derived rows are not kept: the pre-0018 snapshot is the
-- only copy. rollback/0018_remove_derived.sql restores the empty shape.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE users, save_requests, instruction_card_versions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE gardening_jobs, card_links, card_graphs, card_retrieval_embeddings, retrieval_enrollments, card_embeddings, store_config IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- A worker may still hold a live lease; let it finish (or expire) first.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM gardening_jobs WHERE status='running' AND lease_until > clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='remove_derived_requires_no_live_gardening_lease';
  END IF;
  IF EXISTS (SELECT 1 FROM card_embeddings WHERE status='running' AND lease_until > clock_timestamp())
    OR EXISTS (SELECT 1 FROM card_graphs WHERE status='running' AND lease_until > clock_timestamp())
    OR EXISTS (SELECT 1 FROM card_retrieval_embeddings WHERE status='running' AND lease_until > clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='remove_derived_requires_no_live_derivation_lease';
  END IF;
END $$;
--> statement-breakpoint
-- DELETE fires the guard, which returns each job's reserved bytes to
-- users.retained_bytes; DROP TABLE would leave them counted.
DELETE FROM gardening_jobs;
--> statement-breakpoint
DROP TRIGGER gardening_guard ON gardening_jobs;
--> statement-breakpoint
DROP FUNCTION milton_gardening_guard();
--> statement-breakpoint
DROP TABLE gardening_jobs;
--> statement-breakpoint
DROP TRIGGER card_link_guard ON card_links;
--> statement-breakpoint
DROP FUNCTION milton_card_link_guard();
--> statement-breakpoint
DROP TABLE card_links;
--> statement-breakpoint
DROP TABLE card_graphs;
--> statement-breakpoint
DROP TABLE card_retrieval_embeddings;
--> statement-breakpoint
DROP TABLE retrieval_enrollments;
--> statement-breakpoint
DROP TABLE card_embeddings;
--> statement-breakpoint
ALTER TABLE store_config DROP CONSTRAINT config_derivation_budget;
--> statement-breakpoint
ALTER TABLE store_config DROP CONSTRAINT config_derivation_cursor;
--> statement-breakpoint
ALTER TABLE store_config DROP COLUMN derivation_account_budget_micros;
--> statement-breakpoint
ALTER TABLE store_config DROP COLUMN derivation_global_budget_micros;
--> statement-breakpoint
ALTER TABLE store_config DROP COLUMN derivation_budget_revision;
--> statement-breakpoint
ALTER TABLE store_config DROP COLUMN derivation_cursor;
--> statement-breakpoint
-- No CASCADE: this fails if anything still uses the vector type.
DROP EXTENSION vector;
