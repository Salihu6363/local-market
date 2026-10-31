LOCAL MARKET - setup and security notes

WHAT CHANGED
- Accounts use Supabase Auth with PHONE NUMBER + password. Signup: full name, phone, password (email optional). Login: phone + password.
- Passwords are never stored in the app data. Each profile row keeps ownerId (the Supabase user id) and no password field.
- The admin login is gone from the code. Admin rights come only from a user row with isAdmin:true.
- DMs and ID documents are private (row-level security). ID documents are no longer uploaded to the public bucket; they are stored in the verifyRequests row and visible only to the owner and admin.
- Admin can set a listing limit per user (blank = unlimited). The limit shows on the account page.

WARNING: never share your admin login. Change your admin password if you ever shared it, and do not put your admin phone or email into the code or any public file.

OLD ACCOUNTS
Old accounts stored a plaintext password in their row. The first time an old user logs in with the same phone and password, the app creates their Supabase Auth login and removes the stored password. If the phone or password no longer matches, that user must create a new account.

SETUP STEPS (run once in your Supabase dashboard)
1. Open Supabase > Authentication > Providers > Phone. Turn OFF "Confirm phone" so signup finishes without SMS.
2. Open Supabase > SQL Editor. Paste and run the SQL below, in order.
3. Sign up in the app with your phone, then run the one-line SQL in step 6 to make it admin.

-- 1. Enable row level security on the data table
alter table localmarket_store enable row level security;

-- 2. Drop old open policies if they exist
drop policy if exists "public read" on localmarket_store;
drop policy if exists "public write" on localmarket_store;
drop policy if exists "anon all" on localmarket_store;

-- 3. Public read ONLY for listing and user rows (the public listing and profile pages)
create policy "public read listings and users" on localmarket_store
  for select using (id like 'listing:%' or id like 'user:%');

-- 4. Logged-in users can read all other rows (DMs, follows, comments, etc.) only if they are the owner or the receiver
create policy "owner or receiver read" on localmarket_store
  for select to authenticated
  using ((data->>'ownerId') = auth.uid()::text or (data->>'targetOwner') = auth.uid()::text);

-- 5. Owner-only writes: a row can be written only by the auth user whose id is in its ownerId
create policy "owner insert" on localmarket_store
  for insert to authenticated
  with check ((data->>'ownerId') = auth.uid()::text);
create policy "owner update" on localmarket_store
  for update to authenticated
  using ((data->>'ownerId') = auth.uid()::text)
  with check ((data->>'ownerId') = auth.uid()::text);
create policy "owner delete" on localmarket_store
  for delete to authenticated
  using ((data->>'ownerId') = auth.uid()::text);

-- 6. Make YOUR account the admin (replace +2348000000000 with your phone in +234 format)
update localmarket_store set data = jsonb_set(data, '{isAdmin}', 'true'::jsonb) where id like 'user:%' and data->>'ownerId' = (select id::text from auth.users where phone = '+2348000000000');

-- 7. Storage: keep the public bucket for listing photos and avatars only.
-- Dashboard > Storage > localmarket > Policies: keep "public read" for the listings/ and avatars/ folders.
-- Remove any policy that lets anyone upload to verify/ or read verify/.
-- ID documents are no longer uploaded to storage at all (they are in the table).

NOTES
- The row policies above assume the app saves ownerId as the Supabase auth user id (it does).
- If a policy blocks an action, the app shows the error; check the policy with the SQL editor.
- Keep your SQL policies in the dashboard. Do not paste your secret keys anywhere public.


SECURITY FIX (Oct 28)
Run security_fix.sql once in the Supabase SQL Editor. It wipes leftover plaintext passwords, blocks users from setting themselves admin/verified, lets your admin account still verify people and set limits, and stops password rows from being publicly readable. Run it once; nothing in the app needs changing.
