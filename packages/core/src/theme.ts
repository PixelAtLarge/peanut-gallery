/**
 * Default look: the "Conifer, Prep & Wasabi" palette.
 * Deep forest and navy grounds, creamy greens, coastal blues, one warm yellow accent, carbon text.
 *
 * Every role can be overridden (widget: `theme` option; CLI: `theme` in peanut-gallery.config.json),
 * so teams can match their own design system.
 */
export const PALETTE = {
  conifer: '#1E4D36',
  emerald: '#0F7B52',
  wasabi: '#719872',
  matcha: '#9CC98A',
  pistachio: '#CFE1B4',
  seaGlass: '#CDE2F2',
  hydrangea: '#A6BFE5',
  harbor: '#40648A',
  chambray: '#6C8EBD',
  prep: '#152A4A',
  sunnyside: '#EAC26C',
  linen: '#F6F3E4',
  white: '#FFFFFF',
  gull: '#A5B0B6',
  carbon: '#22272B',
} as const;

export interface Theme {
  /** Page / report background */
  bg: string;
  /** Cards, popovers */
  surface: string;
  text: string;
  muted: string;
  line: string;
  heading: string;
  /** Primary actions (Add note, Submit) */
  primary: string;
  primaryHover: string;
  onPrimary: string;
  /** Floating toolbar */
  toolbar: string;
  toolbarButton: string;
  toolbarButtonHover: string;
  onToolbar: string;
  /** "Commenting" state, pins, element outlines in screenshots */
  accent: string;
  onAccent: string;
  /** Hover outline on the element being picked */
  highlight: string;
  highlightTint: string;
  pinLow: string;
  /** Kind tags (bug, copy, layout…) */
  chip: string;
  onChip: string;
  /** Count badge on the Review button */
  count: string;
  onCount: string;
  ghost: string;
  ghostHover: string;
  link: string;
  toast: string;
  onToast: string;
  danger: string;
  onDanger: string;
  success: string;
  successTint: string;
  fontBody: string;
  fontDisplay: string;
  fontMono: string;
}

export const DEFAULT_THEME: Theme = {
  bg: PALETTE.linen,
  surface: PALETTE.white,
  text: PALETTE.carbon,
  muted: '#5A6268',
  line: '#DEDCCB',
  heading: PALETTE.conifer,
  primary: PALETTE.emerald,
  primaryHover: '#006340', // emerald 700
  onPrimary: PALETTE.white,
  toolbar: PALETTE.conifer,
  toolbarButton: '#325D46', // conifer 700
  toolbarButtonHover: '#4E7660', // conifer 600
  onToolbar: PALETTE.white,
  accent: PALETTE.sunnyside,
  onAccent: PALETTE.carbon,
  highlight: PALETTE.emerald,
  highlightTint: 'rgba(15, 123, 82, 0.10)',
  pinLow: PALETTE.gull,
  chip: PALETTE.seaGlass,
  onChip: PALETTE.prep,
  count: PALETTE.pistachio,
  onCount: PALETTE.conifer,
  ghost: '#EDEBE3', // linen 100
  ghostHover: '#DBD8CA', // linen 200
  link: PALETTE.prep,
  toast: PALETTE.prep,
  onToast: PALETTE.linen,
  danger: '#F6E3DF',
  onDanger: '#9B3426',
  success: PALETTE.emerald,
  successTint: '#D4F4E2', // emerald 100
  fontBody: '"Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontDisplay: '"Young Serif", Georgia, "Times New Roman", serif',
  fontMono: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
};

/** Google Fonts stylesheet for the default type (Manrope, Young Serif, JetBrains Mono). */
export const DEFAULT_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Young+Serif&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';

export function resolveTheme(overrides?: Partial<Theme>): Theme {
  return { ...DEFAULT_THEME, ...(overrides ?? {}) };
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

/** `--pg-primary: #0F7B52; …` for every role. */
export function themeToCssVars(theme: Theme): string {
  return (Object.keys(theme) as (keyof Theme)[]).map((k) => `--pg-${kebab(k)}: ${theme[k]};`).join(' ');
}
