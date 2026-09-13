"use client";

import { useState } from "react";
import { SectionCard } from "@/components/app/SectionCard";
import { Modal } from "@/components/app/Modal";
import { ConfirmDeleteButton } from "@/components/app/RememberedAnswerPopup";
import { TextField, TextAreaField } from "@/components/form/fields";
import { saveEssays } from "@/app/app/teach/actions";
import { liveSync } from "@/lib/extension-sync";
import { addEssay, type Essay, type EssaysDoc } from "@/lib/essays";

/**
 * The operator's own written answers, kept as a voice library.
 *
 * Reading order for someone changing this: the library is a REFERENCE, not a queue. Nothing here is
 * "done" or cleared — every row makes the next essay sound more like the operator, so the affordances
 * are read, edit, delete and add, and there is no dismiss.
 *
 * Most rows arrive on their own: rewriting a long answer on the review page captures it (see
 * `isEssayAnswer`). The Add button exists to seed the library with writing that never went through a
 * fill — which is the only way it is useful on day one.
 */
export function EssayLibrary({ initialDoc }: { initialDoc: EssaysDoc }) {
  const [doc, setDoc] = useState<EssaysDoc>(initialDoc);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<Essay | null>(null);
  const [editing, setEditing] = useState<Essay | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ question: string; text: string }>({ question: "", text: "" });
  const [styleNotes, setStyleNotes] = useState(initialDoc.style_notes || "");

  const persist = async (next: EssaysDoc, msg: string) => {
    setDoc(next);
    setSaving(true);
    setNote(null);
    const r = await saveEssays(next);
    setSaving(false);
    if (r.ok) {
      setNote(msg);
      // Push straight to the extension so the NEXT fill already has it — the whole point of the
      // library is that it improves the next application, not the one after a manual re-sync.
      liveSync("profile");
    } else {
      setNote("Couldn't save: " + r.error);
    }
  };

  const saveStyle = () => persist({ ...doc, style_notes: styleNotes }, "Style notes saved ✓");

  const commitDraft = () => {
    const text = draft.text.trim();
    if (!text) { setAdding(false); setEditing(null); return; }
    if (editing) {
      const next = {
        ...doc,
        essays: doc.essays.map((e) => (e.id === editing.id ? { ...e, question: draft.question.trim(), text } : e)),
      };
      setEditing(null);
      void persist(next, "Essay updated ✓");
      return;
    }
    const next = addEssay(doc, {
      id: "essay_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      question: draft.question.trim(),
      text,
      company: "",
      source: "manual",
      created_at: new Date().toISOString(),
    });
    setAdding(false);
    void persist(next, "Essay saved ✓");
  };

  const remove = (id: string) =>
    persist({ ...doc, essays: doc.essays.filter((e) => e.id !== id) }, "Essay deleted ✓");

  const openAdd = () => { setDraft({ question: "", text: "" }); setEditing(null); setAdding(true); };
  const openEdit = (e: Essay) => { setDraft({ question: e.question, text: e.text }); setViewing(null); setEditing(e); };

  return (
    <div className="space-y-6">
      <SectionCard
        title="How I write"
        subtitle="Instructions the samples can't state — length, tone, things to avoid. Sent with every essay the AI drafts."
      >
        <TextAreaField
          label="Style notes"
          value={styleNotes}
          onChange={setStyleNotes}
          rows={2}
          placeholder="e.g. Three sentences max. Concrete and specific. No buzzwords, no “I am passionate about”."
          hint="optional"
        />
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="btn-primary" onClick={saveStyle} disabled={saving}>
            Save style notes
          </button>
          <span className={saving ? "text-xs text-ink-dim" : "text-xs text-verified"}>
            {saving ? "Saving…" : note || ""}
          </span>
        </div>
      </SectionCard>

      <SectionCard
        title={`My essays (${doc.essays.length})`}
        subtitle="Answers you wrote yourself. Future essays match this voice, and may reuse concrete facts from them."
        actions={<button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={openAdd}>Add an essay</button>}
      >
        {doc.essays.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <p className="text-sm text-ink-dim">No essays saved yet.</p>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-ink-faint">
              Rewrite a long answer on a review page and it lands here automatically. Or paste one you
              have already written — the AI has nothing to imitate until there is at least one.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {doc.essays.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-4 py-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setViewing(e)}
                  title="Read the whole essay"
                >
                  <p className="truncate text-sm text-ink">{e.question || "(no question recorded)"}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-faint">{e.text}</p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-label text-ink-faint">
                    {e.text.length} chars
                    {e.company ? " · " + e.company : ""}
                    {e.created_at ? " · " + e.created_at.slice(0, 10) : ""}
                    {e.source === "review" ? " · from a review" : ""}
                  </p>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => openEdit(e)}>Edit</button>
                  <ConfirmDeleteButton onDelete={() => remove(e.id)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Read one in full — `wide` because an essay is prose worth room, like the résumé viewer. */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Essay" subtitle={viewing?.question || ""} wide>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{viewing?.text || ""}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={() => setViewing(null)}>Close</button>
          {viewing && <button type="button" className="btn-primary" onClick={() => openEdit(viewing)}>Edit</button>}
        </div>
      </Modal>

      <Modal
        open={adding || !!editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        title={editing ? "Edit essay" : "Add an essay"}
        subtitle="Your own words. The question matters — it is how the right sample gets picked for a new one."
        wide
      >
        <div className="space-y-4">
          <TextField
            label="The question it answers"
            value={draft.question}
            onChange={(v) => setDraft((d) => ({ ...d, question: v }))}
            placeholder="e.g. List one or two projects that demonstrate your embedded systems experience"
            hint="paste the prompt, or describe it"
          />
          {/* bulletOnEnter deliberately OFF — this is prose, not a bullet list. */}
          <TextAreaField
            label="Your answer"
            value={draft.text}
            onChange={(v) => setDraft((d) => ({ ...d, text: v }))}
            rows={10}
            placeholder="Paste what you wrote."
            hint={draft.text.trim().length + " chars"}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={() => { setAdding(false); setEditing(null); }}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={commitDraft} disabled={!draft.text.trim()}>
            {editing ? "Save" : "Add"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
