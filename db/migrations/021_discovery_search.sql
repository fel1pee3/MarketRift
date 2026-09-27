-- Optional, explicitly requested web search. Existing runs and candidates retain their meaning.
BEGIN;
ALTER TABLE marketrift.discovery_runs
  ADD COLUMN include_external_search boolean NOT NULL DEFAULT false,
  ADD COLUMN external_search_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN external_queries integer NOT NULL DEFAULT 0;
ALTER TABLE marketrift.discovery_candidates
  ADD COLUMN search_provider text,
  ADD COLUMN search_query text;
ALTER TABLE marketrift.discovery_candidates DROP CONSTRAINT discovery_candidates_discovery_method_check;
ALTER TABLE marketrift.discovery_candidates ADD CONSTRAINT discovery_candidates_discovery_method_check
  CHECK (discovery_method IN ('homepage','sitemap','feed','known_url','web_search'));
ALTER TABLE marketrift.discovery_candidates DROP CONSTRAINT discovery_candidates_category_check;
ALTER TABLE marketrift.discovery_candidates ADD CONSTRAINT discovery_candidates_category_check
  CHECK (category IN ('official_site','product','reviews','community','apps','social','news','other'));
COMMIT;
