import type { Application } from "./shared";
import type { ReviewBundle } from "@/lib/review-summary";

// Dev-preview sample data (hard-gated by DEV_PREVIEW) so the tracker + hosted
// review summary are demoable before Supabase + the extension report are wired.

export const SAMPLE_APPS: Application[] = [
  { id: "a1", company: "Comcast", role: "Software Engineering Intern", url: "https://comcast.wd5.myworkdayjobs.com", status: "submitted", needs_review_count: 0, applied_at: "2026-06-24T10:00:00Z", created_at: "2026-06-24T10:00:00Z" },
  { id: "a2", company: "LiveRamp", role: "Data Engineer", url: "https://liveramp.wd5.myworkdayjobs.com", status: "needs_review", needs_review_count: 3, applied_at: "2026-06-26T10:00:00Z", created_at: "2026-06-26T10:00:00Z" },
  { id: "a3", company: "U.S. Bank", role: "Analyst", url: "https://usbank.wd1.myworkdayjobs.com", status: "interviewing", needs_review_count: 0, applied_at: "2026-06-20T10:00:00Z", created_at: "2026-06-20T10:00:00Z" },
  { id: "a4", company: "Magna", role: "Software Engineer", url: "https://magna.wd3.myworkdayjobs.com", status: "offer", needs_review_count: 0, applied_at: "2026-06-18T10:00:00Z", created_at: "2026-06-18T10:00:00Z" },
  { id: "a5", company: "Cambium Learning", role: "Frontend Engineer", url: "https://cambium.wd1.myworkdayjobs.com", status: "rejected", needs_review_count: 0, applied_at: "2026-06-15T10:00:00Z", created_at: "2026-06-15T10:00:00Z" },
];

export const SAMPLE_BUNDLE: ReviewBundle = {
  schema_version: "1.0",
  page: "My Information",
  url: "https://liveramp.wd5.myworkdayjobs.com/…/apply",
  tenant: "liveramp.wd5",
  captured_at: "2026-06-26T10:00:00Z",
  total: 11,
  needs_review_count: 3,
  counts: { filled: 8, filled_review: 3 },
  entries: [
    { field_id: "p1", question_label: "First name", widget_type: "text", canonical_field: "personal_info.first_name", is_required: true, current_value: "Kevin", fill_status: "filled", confidence: "high", confidence_source: "profile_direct", needs_review: false },
    { field_id: "p2", question_label: "Last name", widget_type: "text", canonical_field: "personal_info.last_name", is_required: true, current_value: "Wang", fill_status: "filled", confidence: "high", confidence_source: "profile_direct", needs_review: false },
    { field_id: "p3", question_label: "Email", widget_type: "text", canonical_field: "personal_info.email", is_required: true, current_value: "kevin@example.com", fill_status: "filled", confidence: "high", confidence_source: "profile_direct", needs_review: false },
    { field_id: "p4", question_label: "Country", widget_type: "dropdown", canonical_field: "personal_info.country", is_required: true, current_value: "United States of America", fill_status: "filled", confidence: "high", confidence_source: "exact", match_tier: "exact-normalized", needs_review: false, options: ["United States of America", "United Kingdom", "Canada", "Australia"] },
    { field_id: "p5", question_label: "How did you hear about us?", widget_type: "hierarchical", canonical_field: "how_did_you_hear", current_value: "LinkedIn", fill_status: "filled", confidence: "high", confidence_source: "profile_direct", needs_review: false },
    { field_id: "e1", question_label: "Degree", widget_type: "dropdown", canonical_field: "education[0].degree", current_value: "Bachelors", fill_status: "filled", confidence: "medium", confidence_source: "containment", match_tier: "containment", needs_review: false, options: ["Bachelors", "Masters", "Doctorate", "Associates"] },
    { field_id: "w1", question_label: "Job title", widget_type: "text", canonical_field: "work_experience[0].job_title", current_value: "Software Engineer", fill_status: "filled", confidence: "high", confidence_source: "profile_direct", needs_review: false },
    { field_id: "r1", question_label: "Have you previously been employed by LiveRamp?", widget_type: "radio", canonical_field: "candidateIsPreviousWorker", is_required: true, current_value: "No", fill_status: "filled_review", confidence: "medium", confidence_source: "reason", needs_review: true, needs_review_reason: "employer_match_uncertain", detail: "No match in your employer history — but this sits next to a truthfulness certification.", flag: "employer-match" },
    { field_id: "s1", question_label: "Have you ever been convicted of a felony?", widget_type: "dropdown", canonical_field: "screening.criminal_history", is_required: true, current_value: "No", fill_status: "filled_review", confidence: "medium", confidence_source: "ai_inference", needs_review: true, needs_review_reason: "ai_inferred_sensitive", flag: "ai-choice-sensitive", detail: "Inferred from the absence of any record in your profile. Confirm this is accurate.", options: ["Yes", "No", "Prefer not to say"] },
    { field_id: "eeo1", question_label: "Gender", widget_type: "dropdown", canonical_field: "self_identification.gender", current_value: "Prefer not to say", fill_status: "filled_review", confidence: "low", confidence_source: "ai_inference", needs_review: true, needs_review_reason: "ai_eeo_inferred", flag: "ai-eeo-guess", detail: "Not stated in your profile. The model chose a safe default — verify or change it.", options: ["Male", "Female", "Non-binary", "Prefer not to say"] },
    { field_id: "txt1", question_label: "Why do you want to work at LiveRamp?", widget_type: "textarea", canonical_field: "essay.why_company", is_required: true, current_value: null, fill_status: "not_filled", confidence: "none", needs_review: true, needs_review_reason: "ai_needs_answer", flag: "ai-text-needs-answer", detail: "A required essay with no profile answer — write this one yourself." },
  ],
};

export const SAMPLE_BUNDLE_BY_ID: Record<string, ReviewBundle> = { a2: SAMPLE_BUNDLE };
