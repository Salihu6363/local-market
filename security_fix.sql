-- LOCAL MARKET security fix (run in Supabase SQL Editor, in order)
-- Fixes: (1) old plaintext passwords readable by anyone, (2) users making themselves admin/verified.

-- A. ONE-TIME: delete any plaintext password still stored in user rows.
--    Old users who never logged in since the Supabase Auth migration just log in with
--    phone + password as normal (Supabase Auth), or sign up again if they never migrated.
update localmarket_store set data = data - 'password' where id like 'user:%' and data ? 'password';

-- B. Protect the admin-only fields on user rows (isAdmin, verified, listingLimit).
--    A normal user can still edit their own name/bio/photo/etc, but changing these
--    protected fields only works if the logged-in user is an admin.
create or replace function protect_user_fields() returns trigger as $$
declare
  is_admin boolean;
begin
  if new.id like 'user:%' then
    select exists (
      select 1 from localmarket_store u
      where u.id like 'user:%'
        and u.data->>'ownerId' = auth.uid()::text
        and coalesce(u.data->>'isAdmin','false')::boolean
    ) into is_admin;
    if not coalesce(is_admin, false) then
      if coalesce(new.data->>'isAdmin','false')      is distinct from coalesce(old.data->>'isAdmin','false')
      or coalesce(new.data->>'verified','false')     is distinct from coalesce(old.data->>'verified','false')
      or coalesce(new.data->>'listingLimit','')      is distinct from coalesce(old.data->>'listingLimit','')
      or coalesce(new.data->>'isAdmin','false')::boolean
      or coalesce(new.data->>'verified','false')::boolean
      then
        raise exception 'only an admin can change admin/verified fields';
      end if;
    end if;
  end if;
  return new;
end $$ language plpgsql security definer;

drop trigger if exists protect_user_fields on localmarket_store;
create trigger protect_user_fields
  before insert or update on localmarket_store
  for each row execute function protect_user_fields();

-- C. Let the admin (a normal logged-in user whose row has isAdmin:true) update
--    OTHER users' rows, so verifying someone and setting listing limits still works.
create policy "admin can update user rows" on localmarket_store
  for update to authenticated
  using (
    id like 'user:%'
    and exists (
      select 1 from localmarket_store a
      where a.id like 'user:%'
        and a.data->>'ownerId' = auth.uid()::text
        and coalesce(a.data->>'isAdmin','false')::boolean
    )
  );

-- D. Extra lock on public reads: users rows that still contain a password are never public.
drop policy if exists "public read listings and users" on localmarket_store;
create policy "public read listings and users" on localmarket_store
  for select using (
    id like 'listing:%'
    or (id like 'user:%' and not (data ? 'password'))
  );
