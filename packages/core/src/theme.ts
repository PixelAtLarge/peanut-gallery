/**
 * Default look: the "Conifer, Prep & Wasabi" palette on cool sea-glass and gull neutrals.
 * Deep forest and navy grounds, creamy greens, coastal blues, one warm yellow accent, carbon text.
 * The earlier warm look (linen neutrals) is the "warm" preset.
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

/** Tints of the cool neutrals. */
const COOL = {
  seaGlass50: '#EFF8FF',
  seaGlass100: '#E1EDF6',
  gull100: '#E6ECEF',
  gull200: '#CFD9DF',
  gull300: '#B5C0C5',
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

/** The default: cool sea-glass page, gull lines and ghost buttons. */
export const COOL_THEME: Theme = {
  bg: COOL.seaGlass100,
  surface: PALETTE.white,
  text: PALETTE.carbon,
  muted: '#5A6268',
  line: COOL.gull200,
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
  ghost: COOL.gull100,
  ghostHover: COOL.gull200,
  link: PALETTE.prep,
  toast: PALETTE.prep,
  onToast: COOL.seaGlass50,
  danger: '#F6E3DF',
  onDanger: '#9B3426',
  success: PALETTE.emerald,
  successTint: '#D4F4E2', // emerald 100
  fontBody: '"Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontDisplay: '"Young Serif", Georgia, "Times New Roman", serif',
  fontMono: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
};

/** The original warm look: linen page, warm lines and ghost buttons. `theme: "warm"`. */
export const WARM_THEME: Theme = {
  ...COOL_THEME,
  bg: PALETTE.linen,
  line: '#DEDCCB',
  ghost: '#EDEBE3', // linen 100
  ghostHover: '#DBD8CA', // linen 200
  onToast: PALETTE.linen,
};

export const DEFAULT_THEME: Theme = COOL_THEME;

export const THEME_PRESETS = { cool: COOL_THEME, warm: WARM_THEME } as const;
export type ThemePreset = keyof typeof THEME_PRESETS;

/**
 * What `theme` accepts: a preset name, overrides of the default, or both
 * (`{ preset: "warm", primary: "#5b3df5" }`).
 */
export type ThemeInput = ThemePreset | (Partial<Theme> & { preset?: ThemePreset });

/** Google Fonts stylesheet for the default type (Manrope, Young Serif, JetBrains Mono). */
export const DEFAULT_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Young+Serif&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';

export function resolveTheme(input?: ThemeInput | null): Theme {
  if (!input) return { ...DEFAULT_THEME };
  if (typeof input === 'string') return { ...(THEME_PRESETS[input] ?? DEFAULT_THEME) };
  const { preset, ...overrides } = input;
  return { ...(preset ? (THEME_PRESETS[preset] ?? DEFAULT_THEME) : DEFAULT_THEME), ...overrides };
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

/** `--pg-primary: #0F7B52; …` for every role. */
export function themeToCssVars(theme: Theme): string {
  return (Object.keys(theme) as (keyof Theme)[]).map((k) => `--pg-${kebab(k)}: ${theme[k]};`).join(' ');
}
