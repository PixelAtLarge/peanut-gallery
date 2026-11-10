/**
 * An anchor ties a comment to a DOM element robustly enough to survive
 * minor markup changes. We store several independent signals and resolve
 * using the first that matches confidently.
 */
export interface ElementAnchor {
  /** Stable-ish CSS selector (prefers data-testid / id / semantic path). */
  selector: string;
  /** Normalized, truncated textContent of the element at annotation time. */
  textFingerprint: string;
  /** Tag name, lowercase. */
  tag: string;
  /** Bounding rect relative to the document at annotation time (CSS px). */
  rect: { x: number; y: number; width: number; height: number };
  /** Position of the click inside the element, 0..1 on each axis. */
  offset: { x: number; y: number };
  /** Nearest landmark/heading text to help humans + AI orient. */
  context?: string;
}

export interface Annotation {
  id: string;
  text: string;
  anchor: ElementAnchor;
  /** Page URL (origin + path + search) where the comment was left. */
  pageUrl: string;
  viewport: { width: number; height: number };
  createdAt: string; // ISO 8601
  author?: string;
  /** Optional free-form tag chosen by the reviewer, e.g. "bug", "copy", "layout". */
  kind?: AnnotationKind;
  /**
   * What the reviewer did on this page before leaving the note, oldest first (at most
   * MAX_STEPS, reset on navigation): clicks, typing, options chosen, Enter. Screenshots replay
   * them to reach the same state, e.g. a note inside a modal or on search results. Private
   * fields (passwords, card numbers, email…) are recorded as `masked`, without what was typed.
   */
  steps?: Step[];
}

/** One thing the reviewer did before leaving a note. Plain anchors (older notes) are clicks. */
export interface Step extends ElementAnchor {
  /** Defaults to 'click'. */
  action?: StepAction;
  /** Text typed (`type`) or the option's label (`select`). Absent when `masked`. */
  value?: string;
  /** The field looked private, so what was typed wasn't kept. Replays type a harmless stand-in, or skip it. */
  masked?: boolean;
  /** The field's name as a person would say it: its label, aria-label or placeholder. */
  field?: string;
}

export type StepAction = 'click' | 'type' | 'select' | 'enter';

/** Most steps kept per note. */
export const MAX_STEPS = 8;
/** Longest typed value kept per step. */
export const MAX_STEP_VALUE = 200;

const quote = (t: string, n = 40) => `“${t.length > n ? t.slice(0, n - 1) + '…' : t}”`;

/** Short human label for the element a step acted on, e.g. `“Remove”`, `“Search”` or `button#save`. */
export function stepLabel(step: Pick<Step, 'tag' | 'textFingerprint' | 'selector' | 'field'>): string {
  const f = (step.field ?? '').trim();
  if (f) return quote(f);
  const t = (step.textFingerprint ?? '').trim();
  if (t) return quote(t);
  return step.selector.length > 60 ? step.tag : step.selector;
}

/** A step as a phrase: `clicking “Remove”`, `typing “blue” into “Search”`, `pressing Enter`. */
export function stepPhrase(step: Step): string {
  const label = stepLabel(step);
  switch (step.action ?? 'click') {
    case 'type':
      return step.masked || step.value === undefined ? `filling in ${label}` : `typing ${quote(step.value)} into ${label}`;
    case 'select':
      return step.value === undefined ? `choosing an option in ${label}` : `choosing ${quote(step.value)} in ${label}`;
    case 'enter':
      return 'pressing Enter';
    default:
      return `clicking ${label}`;
  }
}

/** Join step phrases for a sentence: `clicking “Filters” → typing “blue” into “Search”`. */
export function stepsPhrase(steps: Step[]): string {
  return steps.map(stepPhrase).join(' → ');
}

export type AnnotationKind = 'bug' | 'copy' | 'layout' | 'visual' | 'flow' | 'question' | 'praise';

export interface ReviewSession {
  id: string;
  /** Base URL of the hosted prototype. */
  prototypeUrl: string;
  annotations: Annotation[];
  createdAt: string;
  author?: string;
  userAgent?: string;
}

/** A change proposal derived (by Claude) from one or more annotations. */
export interface Proposal {
  id: string;
  title: string;
  /** One-paragraph rationale written for humans. */
  summary: string;
  /** Concrete, implementable instructions for the coding agent. */
  instructions: string;
  /** Annotation ids this proposal addresses. */
  annotationIds: string[];
  /** Issue numbers the annotations came from. */
  issueNumbers: number[];
  /** Pages (URLs) affected; used to decide what to screenshot. */
  pages: string[];
  /** Anchors to screenshot close-up, before and after. */
  focusAnchors: ElementAnchor[];
  effort: 'small' | 'medium' | 'large';
  confidence: number; // 0..1
  /** Who asked for this (distinct reviewers) — computed from the annotations, not by the model. */
  support: { reviewers: string[]; count: number; annotationCount: number };
  /**
   * Present when reviewers disagree about the same element/change. `apply` skips contested
   * proposals until one position is chosen (`peanut-gallery decide <id> <n>`), or applies the
   * model's recommendation with --include-contested.
   */
  contested?: {
    /** Why this is a conflict, one sentence. */
    reason: string;
    positions: ProposalPosition[];
    /** Index into positions the model recommends; `instructions` on the proposal already reflect it. */
    recommended: number;
  };
}

export interface ProposalPosition {
  summary: string;
  instructions: string;
  reviewers: string[];
  annotationIds: string[];
}

export interface ProposalRun {
  proposalId: string;
  branch: string;
  prUrl?: string;
  prNumber?: number;
  comparePath?: string;
  screenshots: { label: string; before: string; after: string }[];
  status: 'proposed' | 'decision-needed' | 'applied' | 'pr-opened' | 'accepted' | 'rejected';
}

export const LABELS = {
  root: 'peanut-gallery',
  feedback: 'peanut-gallery:feedback',
  proposal: 'peanut-gallery:proposal',
  accepted: 'peanut-gallery:accepted',
  rejected: 'peanut-gallery:rejected',
} as const;

export const ISSUE_BLOCK_LANG = 'json peanut-gallery';
