-- Profile v2 — attachments (per-specialty files + general additional documents).
-- Private Storage bucket; objects are namespaced under the user id:
--   attachments/<auth.uid()>/<file>
-- The file references (path/filename/size/mime) are stored inside profile_json
-- (certifications[].specialties[].attachment and the top-level additional_files[]).

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- Path-based ownership: attachments/<auth.uid()>/<file> (mirrors the resumes bucket).
drop policy if exists "attachment objects owner read" on storage.objects;
create policy "attachment objects owner read" on storage.objects
  for select using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachment objects owner write" on storage.objects;
create policy "attachment objects owner write" on storage.objects
  for insert with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachment objects owner update" on storage.objects;
create policy "attachment objects owner update" on storage.objects
  for update using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachment objects owner delete" on storage.objects;
create policy "attachment objects owner delete" on storage.objects
  for delete using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
