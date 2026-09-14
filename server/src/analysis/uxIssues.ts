import type { Issue, UxAnalysis } from "../types.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `ux-${counter}`;
}
export function resetUxIssueIdCounter() {
  counter = 0;
}

function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  const SEVERITY_WEIGHT = { critical: 100, high: 70, medium: 40, low: 15 } as const;
  return {
    ...input,
    category: "ux",
    id: nextId(),
    priorityScore: SEVERITY_WEIGHT[input.severity],
  };
}

const THIN_CONTENT_SEVERE_WORDS = 15;
const THIN_CONTENT_WORDS = 40;

/**
 * Deterministic, evidence-backed UX/content-usability rules against the
 * facts uxCollector.ts already gathered - same MEASURE/ANALYZE split as
 * every other category. Deliberately narrow to objective conditions
 * (literal placeholder text, zero navigation path, etc.) rather than
 * any subjective "does this page feel good" judgment - no LLM is used
 * here or anywhere in this file's dependency chain.
 */
export function detectUxIssues(ux: UxAnalysis, affectedUrl: string): Issue[] {
  const issues: Issue[] = [];

  // ---------------- placeholder / lorem ipsum content ----------------
  if (ux.hasPlaceholderText) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Placeholder ('lorem ipsum') text found in visible content",
        affected: affectedUrl,
        whyItMatters: "Lorem-ipsum-style filler text left in a live page is a strong, unambiguous signal the page was never actually finished with real content.",
        estimatedImpact: `Found: ${ux.placeholderExamples.join(", ")}.`,
        recommendedFix: "Replace the placeholder text with real, reviewed copy before launch.",
        difficulty: "easy",
        source: "measured",
        evidence: ux.placeholderExamples.map((ex) => ({ type: "html" as const, label: "Placeholder text", value: ex })),
      }),
    );
  }

  // ---------------- coming-soon / demo remnants ----------------
  if (ux.hasComingSoonText) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "\"Coming soon\" / under-construction language found on a live page",
        affected: affectedUrl,
        whyItMatters: "Visible text telling visitors the page/site isn't ready yet is a direct signal to users (and search engines) that this isn't launch-ready content.",
        estimatedImpact: `Found: ${ux.comingSoonExamples.join(", ")}.`,
        recommendedFix: "Replace the placeholder messaging with the real page content, or keep the page unpublished until it's ready.",
        difficulty: "easy",
        source: "measured",
        evidence: ux.comingSoonExamples.map((ex) => ({ type: "html" as const, label: "Coming-soon language", value: ex })),
      }),
    );
  }

  // ---------------- thin / near-empty content ----------------
  if (ux.wordCount < THIN_CONTENT_WORDS) {
    const severity = ux.wordCount < THIN_CONTENT_SEVERE_WORDS ? "medium" : "low";
    issues.push(
      makeIssue({
        severity,
        title: "Page has extremely little visible text",
        affected: affectedUrl,
        whyItMatters: "A page with almost no visible content gives users (and search engines) little reason to trust or engage with it - it often signals an unfinished or broken page rather than a genuinely minimal design.",
        estimatedImpact: `Only ${ux.wordCount} visible word(s) detected on this page.`,
        recommendedFix: "Add real, meaningful content, or confirm this page is intentionally minimal (e.g. a redirect/utility page) rather than an unfinished one.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: "Visible word count", value: String(ux.wordCount) }],
      }),
    );
  }

  // ---------------- empty structural sections ----------------
  if (ux.emptySections.count > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Empty <main>/<article>/<section> element(s)",
        affected: affectedUrl,
        whyItMatters: "A structural content region with no text, media, or interactive content usually indicates an unfinished template section or a content-loading failure that static analysis can't distinguish from intentional emptiness.",
        estimatedImpact: `${ux.emptySections.count} empty section-level element(s) found, e.g. ${ux.emptySections.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Fill in the missing content, or remove the empty element if it isn't needed.",
        difficulty: "easy",
        source: "measured",
        evidence: ux.emptySections.examples.map((ex) => ({ type: "html" as const, label: "Empty section-level element", value: ex })),
      }),
    );
  }

  // ---------------- missing primary navigation (page has links elsewhere but no nav structure) ----------------
  if (!ux.hasPrimaryNav && (ux.links.internalCount > 0 || ux.links.externalCount > 0)) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "No primary navigation structure found",
        affected: affectedUrl,
        whyItMatters: "Without a <nav> (or role=\"navigation\") landmark, both assistive-tech users and casual visitors have no clear, consistent way to find the rest of the site from this page.",
        recommendedFix: "Wrap the site's main navigation links in a <nav> element (or add role=\"navigation\") consistently across pages.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "nav / role=navigation elements found", value: "0" }],
      }),
    );
  }

  // ---------------- dead-end page: no navigation path at all ----------------
  const totalOutbound = ux.links.internalCount + ux.links.externalCount + ux.links.mailto.count + ux.links.tel.count;
  if (!ux.hasPrimaryNav && totalOutbound === 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Dead-end page: no links to anywhere else on (or off) the site",
        affected: affectedUrl,
        whyItMatters: "A page with zero navigation, links, or contact paths traps every visitor who lands on it - they can only leave via the browser's back button.",
        recommendedFix: "Add navigation, related links, or a clear next action so visitors aren't stuck once they land here.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: "Outbound links found", value: "0" }],
      }),
    );
  }

  // ---------------- malformed mailto: links ----------------
  if (ux.links.mailto.malformed > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "mailto: link(s) that don't look like a valid email address",
        affected: affectedUrl,
        whyItMatters: "A malformed mailto: link either fails to open the user's mail client correctly or opens it with no usable recipient address.",
        estimatedImpact: `${ux.links.mailto.malformed} of ${ux.links.mailto.count} mailto: link(s) look malformed, e.g. ${ux.links.mailto.malformedExamples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Double-check the email address in each mailto: link for typos or missing @/domain parts.",
        difficulty: "easy",
        source: "measured",
        evidence: ux.links.mailto.malformedExamples.map((ex) => ({ type: "html" as const, label: "Malformed mailto: link", value: ex })),
      }),
    );
  }

  // ---------------- malformed tel: links ----------------
  if (ux.links.tel.malformed > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "tel: link(s) that don't look like a valid phone number",
        affected: affectedUrl,
        whyItMatters: "A malformed tel: link may fail to dial correctly, or dial the wrong number, when tapped on a phone.",
        estimatedImpact: `${ux.links.tel.malformed} of ${ux.links.tel.count} tel: link(s) look malformed, e.g. ${ux.links.tel.malformedExamples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Double-check the phone number in each tel: link (digits, optional +country code, no stray text).",
        difficulty: "easy",
        source: "measured",
        evidence: ux.links.tel.malformedExamples.map((ex) => ({ type: "html" as const, label: "Malformed tel: link", value: ex })),
      }),
    );
  }

  // ---------------- dead-link candidates (Phase 2, heuristic - framed as advisory, not proven) ----------------
  if (ux.deadLinkCandidates.count > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Link(s) with a placeholder destination (href=\"#\" or similar) and no visible click handler",
        affected: affectedUrl,
        whyItMatters: "A link pointing nowhere with no inline onclick usually means it's a dead/decorative control left over from a template - a common AI-generated-site pattern. Static analysis can't rule out a JS framework attaching a real handler at runtime, so treat this as a lead to verify, not a confirmed failure.",
        estimatedImpact: `${ux.deadLinkCandidates.count} link(s) found, e.g. ${ux.deadLinkCandidates.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Point the link at a real destination, or confirm (e.g. via a browser/runtime check) that a script genuinely handles the click before shipping.",
        difficulty: "easy",
        source: "measured",
        evidence: ux.deadLinkCandidates.examples.map((ex) => ({ type: "html" as const, label: "Placeholder-destination link", value: ex })),
      }),
    );
  }

  // ---------------- empty forms (Phase 2, heuristic) ----------------
  if (ux.emptyForms.count > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Form with no real input fields",
        affected: affectedUrl,
        whyItMatters: "A <form> with no visible input/select/textarea fields (only hidden fields, or nothing at all) can't actually collect anything from the user - a common fake-form pattern in template/demo content.",
        estimatedImpact: `${ux.emptyForms.count} empty form(s) found, e.g. ${ux.emptyForms.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Add the real form fields, or remove the form if it isn't meant to collect input.",
        difficulty: "moderate",
        source: "measured",
        evidence: ux.emptyForms.examples.map((ex) => ({ type: "html" as const, label: "Empty form", value: ex })),
      }),
    );
  }

  // ---------------- forms with a placeholder action (Phase 2, heuristic) ----------------
  if (ux.formsWithPlaceholderAction.count > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: 'Form action set to a placeholder value ("#" or javascript:)',
        affected: affectedUrl,
        whyItMatters: "An explicit placeholder action is a common sign the form was never wired up to actually submit anywhere - distinct from simply omitting action, which is a normal pattern for JS-handled forms.",
        estimatedImpact: `${ux.formsWithPlaceholderAction.count} form(s) found, e.g. ${ux.formsWithPlaceholderAction.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Point the form's action at a real endpoint, or confirm JavaScript genuinely handles the submission before shipping.",
        difficulty: "easy",
        source: "measured",
        evidence: ux.formsWithPlaceholderAction.examples.map((ex) => ({ type: "html" as const, label: "Placeholder form action", value: ex })),
      }),
    );
  }

  // ---------------- ambiguous duplicate nav link labels (Session 9) ----------------
  if (ux.duplicateNavLabels.count > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Duplicate navigation link text pointing at different destinations",
        affected: affectedUrl,
        whyItMatters: "When two links in the same navigation say the exact same thing (e.g. \"Read more\" x3) but go to different places, users can't tell them apart by name alone - screen reader users navigating by a list of link names are hit hardest, since they lose the surrounding visual context.",
        estimatedImpact: `${ux.duplicateNavLabels.count} ambiguous label(s) found, e.g. ${ux.duplicateNavLabels.examples.slice(0, 3).join(", ") || "n/a"}.`,
        recommendedFix: "Make each navigation link's text describe its specific destination, or add a visually-hidden suffix (e.g. \"Read more about Pricing\").",
        difficulty: "moderate",
        source: "measured",
        evidence: ux.duplicateNavLabels.examples.map((ex) => ({ type: "html" as const, label: "Ambiguous duplicate nav link text", value: ex })),
      }),
    );
  }

  return issues;
}
