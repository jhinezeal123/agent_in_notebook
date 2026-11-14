// Small line icons in the look of VS Code's codicons, drawn inline so they
// take the text color of the theme.

const PATHS = {
  send: "M8 13V3M3.5 7.5 8 3l4.5 4.5",
  stop: "M4.5 4.5h7v7h-7z",
  notebook: "M3 4.5h1.5M3 8h1.5M3 11.5h1.5M5.5 2h6A1.5 1.5 0 0 1 13 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 4 12.5v-9A1.5 1.5 0 0 1 5.5 2ZM7.5 6.5l1.5 1.5-1.5 1.5",
  "chev-d": "m4 6 4 4 4-4",
  "chev-r": "m6 4 4 4-4 4",
  check: "m3.5 8.5 3 3 6-7",
  close: "m4 4 8 8M12 4l-8 8",
  circle: "M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z",
  open: "M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5",
  pin: "M9.5 2.5 13.5 6.5 11 9l-.5 3L4 5.5l3-.5ZM6.5 9.5 2.5 13.5",
  sparkle: "M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z",
  warning: "M8 2.5 14 13H2ZM8 6.5v3M8 11.2v.3",
  cell: "M2.5 3.5h11v9h-11zM5 6.5h6M5 9.5h4",
  folder: "M2 4.5A1 1 0 0 1 3 3.5h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z",
  swap: "M3 5.5h9M9.5 3l2.5 2.5L9.5 8M13 10.5H4M6.5 8 4 10.5 6.5 13",
  save: "M3 2.5h8l2 2v9H3ZM5.5 2.5v3h5v-3M5 13.5v-4h6v4",
  copy: "M6 5.5h6.5v8H6ZM10 5.5v-3H3.5v8H6",
  sliders: "M2.5 5h5M10.5 5h3M2.5 11h2M7.5 11h6M9 3.5v3M6 9.5v3",
  chart: "M2.5 13.5h11M4.5 11V8.5M8 11V4.5M11.5 11V6.5",
  wand: "M3 13l6.5-6.5M11.5 2.5v3M10 4h3M12.5 8.5v2M11.5 9.5h2",
  flask: "M6 2.5h4M6.5 2.5v4L3 12.5a1 1 0 0 0 .9 1.5h8.2a1 1 0 0 0 .9-1.5L9.5 6.5v-4M5 10h6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, class: cls = "" }: { name: IconName; class?: string }) {
  return (
    <svg class={`i ${cls}`} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
