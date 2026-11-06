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
