-- Resume SOURCE files (.tex / .docx): the editable document the PDF is generated
-- from. One source per user (replaced on upload), stored in the same private
-- `resumes` bucket at <uid>/source.<ext>; the compiled/converted PDF still lands
-- on the `default` row (whose filename is the user-chosen attachment name).
alter table public.resumes drop constraint if exists resumes_kind_check;
alter table public.resumes
  add constraint resumes_kind_check check (kind in ('default', 'variant', 'source'));
