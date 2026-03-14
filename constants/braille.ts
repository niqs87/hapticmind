export type Dots = [boolean, boolean, boolean, boolean, boolean, boolean];

export const TAP_DOT_ORDER = [0, 3, 1, 4, 2, 5];

export const FIELD_DURATION = 50;
export const VIBRATION_PULSE = 15;
export const ROW_GAP = 20;
export const CHARACTER_GAP = 300;

/** Wolniejsze czytanie odpowiedzi (jak hm-matt) – 2× dłuższe interwały. */
export const READ_FIELD_DURATION = 100;
export const READ_ROW_GAP = 40;
export const READ_CHARACTER_GAP = 600;
export const HOLD_DURATION = 800;
export const SEND_TIMEOUT = 3000;
export const CHAR_RESET = 400;

export const TUTORIAL_THRESHOLD = 350;
export const DEFAULT_THRESHOLD = 200;
export const MIN_THRESHOLD = 80;
export const MAX_THRESHOLD = 600;

export const HOLD_CIRCUMFERENCE = 2 * Math.PI * 34;

export type CharGroup = { label: string; chars: { char: string; dots: Dots }[] };

export const CHAR_GROUPS: CharGroup[] = [
  {
    label: 'A-J',
    chars: [
      { char: 'A', dots: [true, false, false, false, false, false] },
      { char: 'B', dots: [true, true, false, false, false, false] },
      { char: 'C', dots: [true, false, false, true, false, false] },
      { char: 'D', dots: [true, false, false, true, true, false] },
      { char: 'E', dots: [true, false, false, false, true, false] },
      { char: 'F', dots: [true, true, false, true, false, false] },
      { char: 'G', dots: [true, true, false, true, true, false] },
      { char: 'H', dots: [true, true, false, false, true, false] },
      { char: 'I', dots: [false, true, false, true, false, false] },
      { char: 'J', dots: [false, true, false, true, true, false] },
    ],
  },
  {
    label: 'K-T',
    chars: [
      { char: 'K', dots: [true, false, true, false, false, false] },
      { char: 'L', dots: [true, true, true, false, false, false] },
      { char: 'M', dots: [true, false, true, true, false, false] },
      { char: 'N', dots: [true, false, true, true, true, false] },
      { char: 'O', dots: [true, false, true, false, true, false] },
      { char: 'P', dots: [true, true, true, true, false, false] },
      { char: 'Q', dots: [true, true, true, true, true, false] },
      { char: 'R', dots: [true, true, true, false, true, false] },
      { char: 'S', dots: [false, true, true, true, false, false] },
      { char: 'T', dots: [false, true, true, true, true, false] },
    ],
  },
  {
    label: 'U-Z',
    chars: [
      { char: 'U', dots: [true, false, true, false, false, true] },
      { char: 'V', dots: [true, true, true, false, false, true] },
      { char: 'W', dots: [false, true, false, true, true, true] },
      { char: 'X', dots: [true, false, true, true, false, true] },
      { char: 'Y', dots: [true, false, true, true, true, true] },
      { char: 'Z', dots: [true, false, true, false, true, true] },
    ],
  },
  {
    label: '0-9',
    chars: [
      { char: '1', dots: [true, false, false, false, false, false] },
      { char: '2', dots: [true, true, false, false, false, false] },
      { char: '3', dots: [true, false, false, true, false, false] },
      { char: '4', dots: [true, false, false, true, true, false] },
      { char: '5', dots: [true, false, false, false, true, false] },
      { char: '6', dots: [true, true, false, true, false, false] },
      { char: '7', dots: [true, true, false, true, true, false] },
      { char: '8', dots: [true, true, false, false, true, false] },
      { char: '9', dots: [false, true, false, true, false, false] },
      { char: '0', dots: [false, true, false, true, true, false] },
    ],
  },
  {
    label: 'Sym',
    chars: [
      { char: '.', dots: [false, false, true, false, true, true] },
      { char: ',', dots: [false, true, false, false, false, false] },
      { char: '?', dots: [false, true, true, false, false, true] },
      { char: '!', dots: [false, true, true, false, true, false] },
      { char: ' ', dots: [false, false, false, false, false, false] },
    ],
  },
];

export type CharEntry = { char: string; dots: Dots };

export const ALL_CHARS: CharEntry[] = CHAR_GROUPS.flatMap((g) => g.chars);

export const BRAILLE_MAP: Record<string, Dots> = {
  A: [true, false, false, false, false, false],
  B: [true, true, false, false, false, false],
  C: [true, false, false, true, false, false],
  D: [true, false, false, true, true, false],
  E: [true, false, false, false, true, false],
  F: [true, true, false, true, false, false],
  G: [true, true, false, true, true, false],
  H: [true, true, false, false, true, false],
  I: [false, true, false, true, false, false],
  J: [false, true, false, true, true, false],
  K: [true, false, true, false, false, false],
  L: [true, true, true, false, false, false],
  M: [true, false, true, true, false, false],
  N: [true, false, true, true, true, false],
  O: [true, false, true, false, true, false],
  P: [true, true, true, true, false, false],
  Q: [true, true, true, true, true, false],
  R: [true, true, true, false, true, false],
  S: [false, true, true, true, false, false],
  T: [false, true, true, true, true, false],
  U: [true, false, true, false, false, true],
  V: [true, true, true, false, false, true],
  W: [false, true, false, true, true, true],
  X: [true, false, true, true, false, true],
  Y: [true, false, true, true, true, true],
  Z: [true, false, true, false, true, true],
  '.': [false, false, true, false, true, true],
  ',': [false, true, false, false, false, false],
  '?': [false, true, true, false, false, true],
  '!': [false, true, true, false, true, false],
  ' ': [false, false, false, false, false, false],
};

export const ROW_DOTS: [number, number][] = [[0, 3], [1, 4], [2, 5]];

/** Kolejność kropek dla animacji (H, M na splash). */
export const DOT_ORDER = [0, 3, 1, 4, 2, 5];

/** Braille dla "H" - Haptic. */
export const H_DOTS: boolean[] = [true, true, false, false, true, false];

/** Braille dla "M" - Mind. */
export const M_DOTS: boolean[] = [true, false, true, true, false, false];

export function getRows(dots: Dots): [[boolean, boolean], [boolean, boolean], [boolean, boolean]] {
  return [
    [dots[0], dots[3]],
    [dots[1], dots[4]],
    [dots[2], dots[5]],
  ];
}

export function dotsToChar(dots: boolean[]): string {
  for (const [ch, d] of Object.entries(BRAILLE_MAP)) {
    if (d.every((v, i) => v === dots[i])) return ch;
  }
  return '?';
}

export function computeAdaptiveThreshold(durations: number[]): number {
  if (durations.length < 4) return DEFAULT_THRESHOLD;
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Math.round(median)));
}
