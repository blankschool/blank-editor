-- Versioned generation review. `templates.document` remains the mutable working copy;
-- every review decision points at an immutable snapshot in design_versions.

create table if not exists public.generation_runs (
  id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  design_id text not null unique references public.templates (id) on delete cascade,
  source_template_id text not null references public.templates (id),
  idempotency_key text not null,
  request_hash text not null,
  processing_status text not null default 'ready'
    check (processing_status in ('queued', 'acquiring_media', 'rendering', 'ready', 'failed', 'canceled')),
  review_status text not null default 'pending'
    check (review_status in ('draft', 'pending', 'changes_requested', 'approved', 'rejected')),
  delivery_status text not null default 'blocked'
    check (delivery_status in ('blocked', 'available', 'downloaded', 'failed')),
  current_version integer not null default 1 check (current_version > 0),
  approved_version integer,
  run_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create index if not exists generation_runs_owner_design_idx
  on public.generation_runs (owner_id, design_id);

create table if not exists public.design_versions (
  generation_id text not null references public.generation_runs (id) on delete cascade,
  version integer not null check (version > 0),
  owner_id uuid not null references auth.users (id) on delete cascade,
  document jsonb not null,
  document_checksum text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (generation_id, version)
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  generation_id text not null references public.generation_runs (id) on delete cascade,
  version integer not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  action text not null check (action in ('approved', 'changes_requested', 'rejected')),
  comment text,
  actor_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (generation_id, version) references public.design_versions (generation_id, version)
);

create index if not exists approvals_generation_created_idx
  on public.approvals (generation_id, created_at desc);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  strategy text not null check (strategy in ('stock', 'ai', 'upload', 'existing_asset')),
  storage_ref text not null,
  mime_type text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  provider text not null,
  external_id text,
  author text,
  attribution_url text,
  license_url text,
  prompt text,
  model text,
  created_at timestamptz not null default now()
);

create table if not exists public.generation_page_assets (
  generation_id text not null references public.generation_runs (id) on delete cascade,
  version integer not null,
  page integer not null check (page > 0),
  layer_name text not null,
  asset_id uuid not null references public.media_assets (id),
  created_at timestamptz not null default now(),
  primary key (generation_id, version, page, layer_name, asset_id),
  foreign key (generation_id, version) references public.design_versions (generation_id, version)
);

create table if not exists public.render_artifacts (
  generation_id text not null references public.generation_runs (id) on delete cascade,
  version integer not null,
  page integer not null check (page > 0),
  format text not null check (format in ('png', 'jpg', 'pdf')),
  storage_path text not null,
  checksum text not null,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (generation_id, version, page, format),
  foreign key (generation_id, version) references public.design_versions (generation_id, version)
);

create table if not exists public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  generation_id text not null references public.generation_runs (id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.generation_runs enable row level security;
alter table public.design_versions enable row level security;
alter table public.approvals enable row level security;
alter table public.media_assets enable row level security;
alter table public.generation_page_assets enable row level security;
alter table public.render_artifacts enable row level security;
alter table public.outbox_events enable row level security;

create policy "generation_runs_own" on public.generation_runs for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "design_versions_own" on public.design_versions for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "approvals_own" on public.approvals for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "media_assets_own" on public.media_assets for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Link tables are reachable only through an owned generation/asset. The app server also
-- scopes every query by owner_id before touching them.
create policy "generation_page_assets_own" on public.generation_page_assets for all
  using (exists (
    select 1 from public.generation_runs g
    where g.id = generation_id and g.owner_id = auth.uid()
  )) with check (exists (
    select 1 from public.generation_runs g
    where g.id = generation_id and g.owner_id = auth.uid()
  ));
create policy "render_artifacts_own" on public.render_artifacts for all
  using (exists (
    select 1 from public.generation_runs g
    where g.id = generation_id and g.owner_id = auth.uid()
  )) with check (exists (
    select 1 from public.generation_runs g
    where g.id = generation_id and g.owner_id = auth.uid()
  ));
create policy "outbox_events_own" on public.outbox_events for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Draft previews are private and are only read through short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('draft-renders', 'draft-renders', false)
on conflict (id) do nothing;

