import { closePool, pool } from "./pool";

const statements = [
  `create schema if not exists agent`,
  `create table if not exists agent.jobs (
    id text primary key,
    feishu_chat_id text,
    feishu_message_id text,
    requester_id text,
    raw_prompt text not null,
    status text not null,
    workflow_id text,
    final_output text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `alter table agent.jobs add column if not exists workdir text`,
  `alter table agent.jobs add column if not exists session_id text`,
  `alter table agent.jobs add column if not exists ingress_origin text not null default 'http'`,
  `alter table agent.jobs add column if not exists display_title text`,
  `alter table agent.jobs add column if not exists orchestration_plan jsonb not null default '{}'`,
  `alter table agent.jobs add column if not exists orchestration_source text`,
  `alter table agent.jobs add column if not exists execution_preflight jsonb not null default '{}'`,
  `alter table agent.jobs add column if not exists execution_queue jsonb not null default '{}'`,
  `alter table agent.jobs add column if not exists execution_retry jsonb not null default '{}'`,
  `alter table agent.jobs add column if not exists routing_mode text not null default 'supervisor_pipeline'`,
  `alter table agent.jobs add column if not exists max_model_calls int not null default 20`,
  `alter table agent.jobs add column if not exists max_cost_usd numeric(18, 6)`,
  `alter table agent.jobs add column if not exists spend_budget jsonb not null default '{}'`,
  `alter table agent.jobs add column if not exists classic_final_gate_enabled boolean not null default false`,
  `alter table agent.jobs add column if not exists discussion_rounds int not null default 2`,
  `alter table agent.jobs add column if not exists completed_at timestamptz`,
  `alter table agent.jobs add column if not exists archived_at timestamptz`,
  `alter table agent.jobs add column if not exists retention_until timestamptz`,
  `alter table agent.jobs add column if not exists cleanup_status text not null default 'active'`,
  `alter table agent.jobs add column if not exists retention_policy jsonb not null default '{}'`,
  `alter table agent.jobs add column if not exists heartbeat_at timestamptz`,
  `alter table agent.jobs add column if not exists heartbeat_status text not null default 'unknown'`,
  `alter table agent.jobs add column if not exists heartbeat_source text`,
  `alter table agent.jobs add column if not exists heartbeat_note text`,
  `alter table agent.jobs add column if not exists stalled_at timestamptz`,
  `update agent.jobs
   set display_title = left(regexp_replace(raw_prompt, '\\s+', ' ', 'g'), 120)
   where display_title is null or btrim(display_title) = ''`,
  `update agent.jobs set session_id = id where session_id is null`,
  `update agent.jobs
   set heartbeat_at = coalesce(heartbeat_at, updated_at, created_at),
       heartbeat_status = case
         when status in ('succeeded', 'failed', 'cancelled') then 'terminal'
         when status = 'waiting_for_human' then 'paused'
         when heartbeat_status = 'unknown' then 'healthy'
         else heartbeat_status
       end,
       heartbeat_source = coalesce(heartbeat_source, 'migration.backfill')
   where heartbeat_at is null
      or heartbeat_status = 'unknown'`,
  `create unique index if not exists jobs_session_id_idx
    on agent.jobs(session_id)
    where session_id is not null`,
  `create unique index if not exists jobs_feishu_message_id_idx
    on agent.jobs(feishu_message_id)
    where feishu_message_id is not null`,
  `create table if not exists agent.job_events (
    id bigserial primary key,
    job_id text not null references agent.jobs(id),
    event_type text not null,
    payload jsonb not null default '{}',
    created_at timestamptz not null default now()
  )`,
  `lock table agent.job_events in access exclusive mode;
   create sequence if not exists agent.job_event_stream_id_seq;
   alter table agent.job_events add column if not exists stream_id bigint;
   update agent.job_events set stream_id = id where stream_id is null;
   select setval(
     'agent.job_event_stream_id_seq',
     greatest(
       coalesce((select max(stream_id) from agent.job_events), 0),
       (select last_value from agent.job_event_stream_id_seq),
       1
     ),
     true
   );
   create or replace function agent.assign_job_event_stream_id()
   returns trigger
   language plpgsql
   as $function$
   begin
     perform pg_advisory_xact_lock(hashtextextended('agent.job_event_stream_commit_order_v1', 0));
     new.stream_id := nextval('agent.job_event_stream_id_seq');
     return new;
   end
   $function$;
   do $block$
   begin
     if not exists (
       select 1
       from pg_trigger
       where tgrelid = 'agent.job_events'::regclass
         and tgname = 'job_events_assign_stream_id'
         and not tgisinternal
     ) then
       create trigger job_events_assign_stream_id
       before insert on agent.job_events
       for each row execute function agent.assign_job_event_stream_id();
     end if;
   end
   $block$;
   alter table agent.job_events alter column stream_id set not null;
   create unique index if not exists job_events_stream_id_idx
     on agent.job_events(stream_id)`,
  `create table if not exists agent.agent_events (
    id bigserial primary key,
    session_id text not null,
    job_id text not null references agent.jobs(id),
    stage_id text,
    seq int not null,
    actor text not null,
    event_type text not null,
    payload jsonb not null default '{}',
    artifact_id text,
    group_message_id text,
    feishu_message_id text,
    created_at timestamptz not null default now(),
    unique(session_id, seq)
  )`,
  `create table if not exists agent.artifacts (
    id text primary key,
    job_id text not null references agent.jobs(id),
    stage_id text,
    type text not null,
    title text,
    content text,
    uri text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now()
  )`,
  `create table if not exists agent.job_stages (
    id text primary key,
    job_id text not null references agent.jobs(id),
    stage_index int not null,
    stage_type text not null,
    agent_id text not null,
    name text not null,
    status text not null,
    input_artifact_id text references agent.artifacts(id),
    output_artifact_id text references agent.artifacts(id),
    acceptance_criteria jsonb not null default '[]',
    retry_count int not null default 0,
    max_retries int not null default 3,
    original_agent_session_id text,
    original_test_session_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(job_id, stage_index)
  )`,
  `create table if not exists agent.stage_attempts (
    id text primary key,
    stage_id text not null references agent.job_stages(id),
    attempt_no int not null,
    agent_id text not null,
    agent_session_id text,
    input_artifact_id text references agent.artifacts(id),
    output_artifact_id text references agent.artifacts(id),
    status text not null,
    error text,
    started_at timestamptz,
    finished_at timestamptz,
    unique(stage_id, attempt_no)
  )`,
  `create table if not exists agent.test_reviews (
    id text primary key,
    stage_id text not null references agent.job_stages(id),
    attempt_id text references agent.stage_attempts(id),
    test_agent_id text not null,
    test_agent_session_id text,
    verdict text not null,
    issue_count int not null default 0,
    report_artifact_id text references agent.artifacts(id),
    required_fixes jsonb not null default '[]',
    created_at timestamptz not null default now()
  )`,
  `create table if not exists agent.artifact_files (
    id text primary key,
    artifact_id text not null references agent.artifacts(id) on delete cascade,
    job_id text not null references agent.jobs(id) on delete cascade,
    stage_id text references agent.job_stages(id),
    kind text not null check (kind in ('image', 'video', 'document')),
    status text not null check (status in ('available', 'remote_only', 'download_failed', 'missing')),
    file_path text,
    external_url text,
    file_name text not null,
    mime_type text,
    format text,
    size_bytes bigint check (size_bytes is null or size_bytes >= 0),
    width int check (width is null or width > 0),
    height int check (height is null or height > 0),
    checksum_sha256 text,
    source text,
    error text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.artifact_deliveries (
    id text primary key,
    job_id text not null references agent.jobs(id) on delete cascade,
    artifact_file_id text not null references agent.artifact_files(id) on delete cascade,
    deliverable_index int not null check (deliverable_index >= 0),
    required boolean not null default true,
    target text not null check (target in ('conversation', 'desktop', 'workspace', 'custom')),
    target_path text,
    requested_file_name text not null,
    authorization_status text not null default 'required'
      check (authorization_status in ('authorized', 'required', 'revoked', 'invalid')),
    authorization_kind text
      check (authorization_kind is null or authorization_kind in ('conversation', 'desktop', 'registered_workspace', 'custom_grant')),
    authorization_id text,
    authorized_root_path text,
    destination_relative_path text,
    destination_path text,
    authorization_error text,
    status text not null default 'pending' check (status in ('pending', 'delivering', 'succeeded', 'failed', 'cancelled')),
    attempt_count int not null default 0 check (attempt_count >= 0),
    claim_token text,
    lease_expires_at timestamptz,
    expected_size_bytes bigint check (expected_size_bytes is null or expected_size_bytes >= 0),
    expected_checksum_sha256 text,
    delivered_path text,
    delivered_size_bytes bigint check (delivered_size_bytes is null or delivered_size_bytes >= 0),
    delivered_checksum_sha256 text,
    last_error text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    unique(job_id, deliverable_index)
  )`,
  `create table if not exists agent.group_messages (
    id text primary key,
    job_id text not null references agent.jobs(id),
    stage_id text references agent.job_stages(id),
    sender_agent_id text not null,
    mention_agent_id text,
    message_type text not null,
    content text not null,
    artifact_id text references agent.artifacts(id),
    feishu_message_id text,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists agent.model_calls (
    id text primary key,
    idempotency_key text not null unique,
    job_id text not null references agent.jobs(id),
    stage_id text references agent.job_stages(id),
    attempt_no int not null,
    action_type text not null,
    agent_id text not null,
    agent_session_id text,
    request_hash text,
    status text not null,
    response_payload jsonb,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.experience_candidates (
    id text primary key,
    source_job_id text not null references agent.jobs(id),
    kind text not null,
    scope text not null,
    scope_key text not null default '',
    status text not null default 'candidate',
    summary text not null,
    evidence jsonb not null default '[]',
    confidence numeric(4, 3) not null,
    utility_score numeric(4, 3) not null default 0,
    decay_score numeric(4, 3) not null default 0,
    occurrence_count int not null default 1,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    adopted_at timestamptz,
    rejected_at timestamptz,
    last_recalled_at timestamptz,
    recall_count int not null default 0,
    last_reinforced_at timestamptz,
    unique(source_job_id, kind, scope, scope_key)
  )`,
  `alter table agent.experience_candidates add column if not exists utility_score numeric(4, 3) not null default 0`,
  `alter table agent.experience_candidates add column if not exists decay_score numeric(4, 3) not null default 0`,
  `alter table agent.experience_candidates add column if not exists last_recalled_at timestamptz`,
  `alter table agent.experience_candidates add column if not exists recall_count int not null default 0`,
  `alter table agent.experience_candidates add column if not exists last_reinforced_at timestamptz`,
  `create table if not exists agent.task_plans (
    id text primary key,
    job_id text not null references agent.jobs(id),
    title text not null,
    summary text,
    status text not null default 'active',
    source text not null default 'manual',
    source_artifact_id text references agent.artifacts(id),
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.task_plan_items (
    id text primary key,
    plan_id text not null references agent.task_plans(id) on delete cascade,
    position int not null,
    title text not null,
    body text,
    status text not null default 'pending',
    agent_id text,
    stage_id text references agent.job_stages(id),
    artifact_id text references agent.artifacts(id),
    acceptance_criteria jsonb not null default '[]',
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    unique(plan_id, position)
  )`,
  `create table if not exists agent.tool_approval_requests (
    id text primary key,
    job_id text not null references agent.jobs(id),
    session_id text not null,
    stage_id text references agent.job_stages(id),
    agent_id text not null,
    requester_actor text not null default 'tool-gateway',
    tool_name text not null,
    action_type text not null,
    risk_level text not null default 'medium',
    reason text,
    command text,
    target text,
    input jsonb not null default '{}',
    policy jsonb not null default '{}',
    status text not null default 'pending',
    decision_reason text,
    decided_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz,
    decided_at timestamptz,
    consumed_at timestamptz
  )`,
  `create table if not exists agent.model_providers (
    id text primary key,
    display_name text not null,
    base_url text not null,
    default_model text,
    api_key_configured boolean not null default false,
    api_key_fingerprint text,
    verification_status text not null default 'unknown',
    last_verified_at timestamptz,
    last_error text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.agent_configs (
    id text primary key,
    display_name text not null,
    agent_role text not null,
    required boolean not null default true,
    enabled boolean not null default true,
    provider_id text references agent.model_providers(id),
    model text,
    api_key_configured boolean not null default false,
    api_key_fingerprint text,
    workspace_path text,
    prompt_template_path text,
    tools jsonb not null default '[]',
    openclaw_sync_status text not null default 'pending',
    openclaw_agent_path text,
    last_synced_at timestamptz,
    last_error text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.skill_registry (
    id text primary key,
    name text not null,
    description text,
    enabled boolean not null default true,
    source text not null default 'user',
    config jsonb not null default '{}',
    diagnostics jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.mcp_servers (
    id text primary key,
    name text not null,
    command text not null,
    args jsonb not null default '[]',
    env_keys jsonb not null default '[]',
    enabled boolean not null default true,
    status text not null default 'unknown',
    last_checked_at timestamptz,
    last_error text,
    config jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.agent_mcp_policies (
    id text primary key,
    agent_config_id text not null references agent.agent_configs(id) on delete cascade,
    mcp_server_id text not null references agent.mcp_servers(id) on delete cascade,
    enabled boolean not null default true,
    allow_tools_list boolean not null default true,
    allow_resources_list boolean not null default false,
    allow_all_tools boolean not null default false,
    allowed_tools jsonb not null default '[]',
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(agent_config_id, mcp_server_id)
  )`,
  `create table if not exists agent.registered_workspaces (
    id text primary key,
    root_path text not null,
    root_path_key text not null unique,
    display_name text,
    enabled boolean not null default true,
    approval_id text references agent.tool_approval_requests(id),
    registered_by text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_used_at timestamptz
  )`,
  `create table if not exists agent.artifact_destination_grants (
    id text primary key,
    root_path text not null,
    root_path_key text not null unique,
    display_name text,
    enabled boolean not null default true,
    approval_id text not null references agent.tool_approval_requests(id),
    granted_by text,
    expires_at timestamptz,
    revoked_at timestamptz,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_used_at timestamptz
  )`,
  `create table if not exists agent.conversation_projects (
    id text primary key,
    name text not null,
    workspace_path text,
    pinned boolean not null default false,
    archived_at timestamptz,
    deleted_at timestamptz,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.model_call_spend (
    id text primary key,
    reservation_key text not null unique,
    idempotency_key text not null,
    job_id text references agent.jobs(id),
    stage_id text references agent.job_stages(id),
    requester_id text,
    provider_id text not null,
    model text,
    agent_id text not null,
    action_type text not null,
    route_index int not null,
    route_attempt_no int not null,
    status text not null,
    reserved_usd numeric(18, 6) not null default 0,
    actual_usd numeric(18, 6),
    currency text not null default 'USD',
    pricing_source text,
    reservation_basis jsonb not null default '{}',
    usage jsonb not null default '{}',
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    settled_at timestamptz,
    released_at timestamptz,
    constraint model_call_spend_status_check check (
      status in ('reserved', 'outcome_unknown', 'settled', 'settled_estimate', 'released', 'blocked')
    ),
    constraint model_call_spend_amount_check check (
      reserved_usd >= 0 and (actual_usd is null or actual_usd >= 0)
    ),
    constraint model_call_spend_currency_check check (currency = 'USD'),
    constraint model_call_spend_route_check check (route_index >= 0 and route_attempt_no >= 1)
  )`,
  `alter table agent.model_call_spend alter column job_id drop not null`,
  `do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conname = 'jobs_max_cost_usd_check'
        and conrelid = 'agent.jobs'::regclass
    ) then
      alter table agent.jobs add constraint jobs_max_cost_usd_check
        check (max_cost_usd is null or max_cost_usd >= 0);
    end if;
  end $$`,
  `do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conname = 'model_call_spend_status_check'
        and conrelid = 'agent.model_call_spend'::regclass
    ) then
      alter table agent.model_call_spend add constraint model_call_spend_status_check
        check (status in ('reserved', 'outcome_unknown', 'settled', 'settled_estimate', 'released', 'blocked'));
    end if;
    if not exists (
      select 1 from pg_constraint
      where conname = 'model_call_spend_amount_check'
        and conrelid = 'agent.model_call_spend'::regclass
    ) then
      alter table agent.model_call_spend add constraint model_call_spend_amount_check
        check (reserved_usd >= 0 and (actual_usd is null or actual_usd >= 0));
    end if;
    if not exists (
      select 1 from pg_constraint
      where conname = 'model_call_spend_currency_check'
        and conrelid = 'agent.model_call_spend'::regclass
    ) then
      alter table agent.model_call_spend add constraint model_call_spend_currency_check
        check (currency = 'USD');
    end if;
    if not exists (
      select 1 from pg_constraint
      where conname = 'model_call_spend_route_check'
        and conrelid = 'agent.model_call_spend'::regclass
    ) then
      alter table agent.model_call_spend add constraint model_call_spend_route_check
        check (route_index >= 0 and route_attempt_no >= 1);
    end if;
  end $$`,
  `create table if not exists agent.model_call_queue (
    id text primary key,
    request_key text not null unique,
    idempotency_key text not null,
    job_id text not null references agent.jobs(id) on delete cascade,
    stage_id text references agent.job_stages(id) on delete cascade,
    route_index int not null,
    agent_id text not null,
    provider_id text not null,
    status text not null,
    lease_owner_id text,
    queued_at timestamptz not null default now(),
    acquired_at timestamptz,
    released_at timestamptz,
    expires_at timestamptz,
    global_limit int not null,
    provider_limit int not null,
    agent_limit int not null,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.conversations (
    id text primary key,
    project_id text not null references agent.conversation_projects(id) on delete cascade,
    title text not null,
    draft text not null default '',
    attachments jsonb not null default '[]',
    pinned boolean not null default false,
    unread boolean not null default false,
    archived_at timestamptz,
    deleted_at timestamptz,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.conversation_messages (
    id text primary key,
    conversation_id text not null references agent.conversations(id) on delete cascade,
    role text not null,
    body text not null,
    status text not null default 'sent',
    job_id text references agent.jobs(id) on delete set null,
    attachments jsonb not null default '[]',
    metadata jsonb not null default '{}',
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `alter table agent.jobs
    add column if not exists conversation_id text references agent.conversations(id) on delete set null`,
  `alter table agent.jobs
    add column if not exists source_message_id text references agent.conversation_messages(id) on delete set null`,
  `alter table agent.conversation_projects add column if not exists deleted_at timestamptz`,
  `alter table agent.conversations add column if not exists deleted_at timestamptz`,
  `alter table agent.conversations add column if not exists attachments jsonb not null default '[]'`,
  `alter table agent.conversation_messages add column if not exists deleted_at timestamptz`,
  `create table if not exists agent.scheduled_tasks (
    id text primary key,
    title text not null,
    raw_prompt text not null,
    schedule_type text not null default 'manual',
    enabled boolean not null default true,
    workspace_path text,
    routing_mode text not null default 'supervisor_pipeline',
    max_model_calls int not null default 20,
    provider_id text references agent.model_providers(id),
    agent_config_id text references agent.agent_configs(id),
    run_at timestamptz,
    interval_seconds int,
    next_run_at timestamptz,
    last_run_at timestamptz,
    status text not null default 'idle',
    last_job_id text references agent.jobs(id),
    last_error text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists agent.runtime_maintenance_state (
    maintenance_id text primary key,
    status text not null default 'never_run',
    owner_id text,
    run_id text,
    trigger text,
    last_started_at timestamptz,
    last_completed_at timestamptz,
    last_succeeded_at timestamptz,
    next_run_at timestamptz,
    last_error text,
    last_result jsonb not null default '{}',
    total_runs bigint not null default 0,
    consecutive_failures int not null default 0,
    updated_at timestamptz not null default now()
  )`,
  `alter table agent.artifacts
    drop constraint if exists artifacts_stage_id_fkey`,
  `alter table agent.artifacts
    add constraint artifacts_stage_id_fkey
    foreign key (stage_id) references agent.job_stages(id)`,
  `create index if not exists job_events_job_id_created_at_idx
    on agent.job_events(job_id, created_at)`,
  `create index if not exists agent_events_session_seq_idx
    on agent.agent_events(session_id, seq)`,
  `create index if not exists agent_events_job_id_created_at_idx
    on agent.agent_events(job_id, created_at)`,
  `create index if not exists agent_events_stage_id_seq_idx
    on agent.agent_events(stage_id, seq)`,
  `create index if not exists jobs_status_created_at_idx
    on agent.jobs(status, created_at)`,
  `create index if not exists jobs_ingress_origin_created_at_idx
    on agent.jobs(ingress_origin, created_at)`,
  `create index if not exists jobs_created_at_id_idx
    on agent.jobs(created_at, id)`,
  `create index if not exists jobs_updated_at_id_idx
    on agent.jobs(updated_at, id)`,
  `create index if not exists jobs_retention_until_cleanup_status_idx
    on agent.jobs(retention_until, cleanup_status)
    where archived_at is not null`,
  `create index if not exists jobs_heartbeat_status_at_idx
    on agent.jobs(heartbeat_status, heartbeat_at)`,
  `create index if not exists jobs_stalled_at_idx
    on agent.jobs(stalled_at desc)
    where stalled_at is not null`,
  `create index if not exists artifacts_job_id_created_at_idx
    on agent.artifacts(job_id, created_at)`,
  `do $$ begin
     if not exists (
       select 1
       from pg_constraint
       where conrelid = 'agent.artifact_files'::regclass
         and conname = 'artifact_files_kind_check'
         and pg_get_constraintdef(oid) like '%document%'
     ) then
       alter table agent.artifact_files drop constraint if exists artifact_files_kind_check;
       alter table agent.artifact_files
         add constraint artifact_files_kind_check
         check (kind in ('image', 'video', 'document'));
     end if;
   end $$`,
  `create index if not exists artifact_files_job_id_created_at_idx
    on agent.artifact_files(job_id, created_at)`,
  `create index if not exists artifact_files_artifact_id_idx
    on agent.artifact_files(artifact_id, created_at)`,
  `alter table agent.artifact_deliveries
    add column if not exists authorization_status text not null default 'required'`,
  `alter table agent.artifact_deliveries
    add column if not exists authorization_kind text`,
  `alter table agent.artifact_deliveries
    add column if not exists authorization_id text`,
  `alter table agent.artifact_deliveries
    add column if not exists authorized_root_path text`,
  `alter table agent.artifact_deliveries
    add column if not exists destination_relative_path text`,
  `alter table agent.artifact_deliveries
    add column if not exists destination_path text`,
  `alter table agent.artifact_deliveries
    add column if not exists authorization_error text`,
  `update agent.artifact_deliveries
   set authorization_status = 'authorized',
       authorization_kind = target,
       authorization_error = null
   where target in ('conversation', 'desktop')
     and authorization_kind is null`,
  `do $$ begin
     alter table agent.artifact_deliveries
       add constraint artifact_deliveries_authorization_status_check
       check (authorization_status in ('authorized', 'required', 'revoked', 'invalid'));
   exception when duplicate_object then null;
   end $$`,
  `do $$ begin
     alter table agent.artifact_deliveries
       add constraint artifact_deliveries_authorization_kind_check
       check (authorization_kind is null or authorization_kind in ('conversation', 'desktop', 'registered_workspace', 'custom_grant'));
   exception when duplicate_object then null;
   end $$`,
  `create index if not exists artifact_deliveries_job_status_idx
    on agent.artifact_deliveries(job_id, status, created_at)`,
  `create index if not exists artifact_deliveries_lease_idx
    on agent.artifact_deliveries(status, lease_expires_at)
    where status = 'delivering'`,
  `create index if not exists artifact_deliveries_authorization_idx
    on agent.artifact_deliveries(authorization_status, target, updated_at)`,
  `create index if not exists job_stages_job_id_stage_index_idx
    on agent.job_stages(job_id, stage_index)`,
  `create index if not exists stage_attempts_stage_id_attempt_no_idx
    on agent.stage_attempts(stage_id, attempt_no)`,
  `create index if not exists test_reviews_stage_id_created_at_idx
    on agent.test_reviews(stage_id, created_at)`,
  `create index if not exists group_messages_job_id_created_at_idx
    on agent.group_messages(job_id, created_at)`,
  `create index if not exists group_messages_stage_id_created_at_idx
    on agent.group_messages(stage_id, created_at)`,
  `create index if not exists model_calls_job_id_created_at_idx
    on agent.model_calls(job_id, created_at)`,
  `create index if not exists model_calls_stage_attempt_idx
    on agent.model_calls(stage_id, attempt_no, action_type)`,
  `create index if not exists model_call_spend_job_created_idx
    on agent.model_call_spend(job_id, created_at)`,
  `create index if not exists model_call_spend_requester_created_idx
    on agent.model_call_spend(requester_id, created_at)
    where requester_id is not null`,
  `create index if not exists model_call_spend_provider_created_idx
    on agent.model_call_spend(provider_id, created_at)`,
  `create index if not exists model_call_spend_idempotency_idx
    on agent.model_call_spend(idempotency_key, status)`,
  `alter table agent.model_calls add column if not exists request_reference jsonb not null default '{}'`,
  `alter table agent.model_calls add column if not exists reconciliation jsonb not null default '{}'`,
  `alter table agent.model_calls add column if not exists claim_token text`,
  `alter table agent.model_calls add column if not exists lease_expires_at timestamptz`,
  `alter table agent.model_calls add column if not exists lease_recovery_status text`,
  `alter table agent.model_calls add column if not exists lease_recovery_checked_at timestamptz`,
  `create index if not exists model_calls_active_lease_idx
    on agent.model_calls(status, lease_expires_at)
    where status = 'started'`,
  `create index if not exists model_calls_lease_recovery_idx
    on agent.model_calls(lease_recovery_status, lease_recovery_checked_at desc)
    where lease_recovery_status is not null`,
  `create index if not exists model_call_queue_active_idx
    on agent.model_call_queue(status, expires_at)`,
  `create index if not exists model_call_queue_provider_idx
    on agent.model_call_queue(provider_id, status, queued_at)`,
  `create index if not exists model_call_queue_agent_idx
    on agent.model_call_queue(agent_id, status, queued_at)`,
  `create index if not exists model_call_queue_job_idx
    on agent.model_call_queue(job_id, status, queued_at)`,
  `create index if not exists experience_candidates_status_updated_at_idx
    on agent.experience_candidates(status, updated_at desc)`,
  `create index if not exists experience_candidates_scope_idx
    on agent.experience_candidates(scope, scope_key, status)`,
  `create index if not exists experience_candidates_kind_scope_status_idx
    on agent.experience_candidates(kind, scope, scope_key, status)`,
  `create index if not exists experience_candidates_reuse_rank_idx
    on agent.experience_candidates(status, utility_score desc, decay_score asc, updated_at desc)`,
  `create index if not exists task_plans_job_id_updated_at_idx
    on agent.task_plans(job_id, updated_at desc)`,
  `create index if not exists task_plans_status_updated_at_idx
    on agent.task_plans(status, updated_at desc)`,
  `create index if not exists task_plan_items_plan_position_idx
    on agent.task_plan_items(plan_id, position)`,
  `create index if not exists task_plan_items_status_idx
    on agent.task_plan_items(status, updated_at desc)`,
  `create index if not exists tool_approval_requests_status_updated_at_idx
    on agent.tool_approval_requests(status, updated_at desc)`,
  `create index if not exists tool_approval_requests_job_created_at_idx
    on agent.tool_approval_requests(job_id, created_at desc)`,
  `create index if not exists tool_approval_requests_session_created_at_idx
    on agent.tool_approval_requests(session_id, created_at desc)`,
  `create index if not exists tool_approval_requests_stage_created_at_idx
    on agent.tool_approval_requests(stage_id, created_at desc)
    where stage_id is not null`,
  `create index if not exists model_providers_updated_at_idx
    on agent.model_providers(updated_at desc)`,
  `create index if not exists model_providers_verification_status_idx
    on agent.model_providers(verification_status, updated_at desc)`,
  `create index if not exists agent_configs_role_idx
    on agent.agent_configs(agent_role, required, enabled)`,
  `create index if not exists agent_configs_provider_idx
    on agent.agent_configs(provider_id)
    where provider_id is not null`,
  `create index if not exists skill_registry_enabled_idx
    on agent.skill_registry(enabled, updated_at desc)`,
  `create index if not exists mcp_servers_enabled_status_idx
    on agent.mcp_servers(enabled, status, updated_at desc)`,
  `create index if not exists agent_mcp_policies_agent_idx
    on agent.agent_mcp_policies(agent_config_id, enabled, updated_at desc)`,
  `create index if not exists agent_mcp_policies_server_idx
    on agent.agent_mcp_policies(mcp_server_id, enabled, updated_at desc)`,
  `create index if not exists registered_workspaces_enabled_idx
    on agent.registered_workspaces(enabled, updated_at desc)`,
  `create index if not exists artifact_destination_grants_active_idx
    on agent.artifact_destination_grants(enabled, expires_at, updated_at desc)`,
  `create index if not exists conversation_projects_active_updated_idx
    on agent.conversation_projects(archived_at, pinned desc, updated_at desc)
    where deleted_at is null`,
  `create index if not exists conversations_project_updated_idx
    on agent.conversations(project_id, archived_at, pinned desc, updated_at desc)
    where deleted_at is null`,
  `create index if not exists conversation_messages_conversation_created_idx
    on agent.conversation_messages(conversation_id, created_at, id)
    where deleted_at is null`,
  `create index if not exists conversation_messages_job_idx
    on agent.conversation_messages(job_id)
    where job_id is not null`,
  `create index if not exists jobs_conversation_created_idx
    on agent.jobs(conversation_id, created_at desc)
    where conversation_id is not null`,
  `create unique index if not exists jobs_source_message_id_idx
    on agent.jobs(source_message_id)
    where source_message_id is not null`,
  `create index if not exists scheduled_tasks_enabled_next_run_idx
    on agent.scheduled_tasks(enabled, next_run_at)
    where next_run_at is not null`,
  `create index if not exists scheduled_tasks_status_updated_idx
    on agent.scheduled_tasks(status, updated_at desc)`,
  `create index if not exists scheduled_tasks_provider_idx
    on agent.scheduled_tasks(provider_id)
    where provider_id is not null`,
  `create index if not exists scheduled_tasks_agent_config_idx
    on agent.scheduled_tasks(agent_config_id)
    where agent_config_id is not null`,
  `create index if not exists runtime_maintenance_next_run_idx
    on agent.runtime_maintenance_state(next_run_at)`
];

export async function runMigrations() {
  for (const statement of statements) {
    await pool.query(statement);
  }
}

async function main() {
  await runMigrations();
  console.log("Database migration complete");
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(closePool);
}
