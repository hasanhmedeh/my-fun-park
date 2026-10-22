// Inline SVG icons (24×24, drawn with the current colour), so they cost no request and follow the
// text colour. Icons that point somewhere (arrows) are mirrored on right-to-left pages by CSS
// (.icon-dir); everything else, logos included, stays as drawn.

import { esc } from './text.ts';

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const PATHS: Record<string, string> = {
  // the fair's tent, as in favicon.svg (filled, in the fair's colours)
  logo: `<path d="M12 1.5v3" stroke="#fff5e3" stroke-width=".7" stroke-linecap="round"/><path d="M12 1.5l2.6.9-2.6.9z" fill="#ffc23d"/><path d="M3.7 11.2 12 3.7l8.3 7.5z" fill="#ff4d6d"/><path d="M3.7 11.2h4.1L12 3.7zm8.3-7.5 4.2 7.5h4.1z" fill="#fff5e3"/><rect x="5.2" y="11.2" width="13.6" height="8.3" rx="1.1" fill="#ffc23d"/><path d="M9.4 19.5v-3.4a2.6 2.6 0 0 1 5.2 0v3.4z" fill="#1d1238"/>`,
  play: `<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/>`,
  pause: `<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>`,
  arrow: `<path d="M5 12h14M13 6l6 6-6 6" ${STROKE}/>`,
  globe: `<circle cx="12" cy="12" r="9" ${STROKE}/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" ${STROKE}/>`,
  menu: `<path d="M4 7h16M4 12h16M4 17h16" ${STROKE}/>`,
  close: `<path d="M6 6l12 12M18 6 6 18" ${STROKE}/>`,
  chevron: `<path d="m6 9 6 6 6-6" ${STROKE}/>`,
  share: `<circle cx="18" cy="5" r="2.6" ${STROKE}/><circle cx="6" cy="12" r="2.6" ${STROKE}/><circle cx="18" cy="19" r="2.6" ${STROKE}/><path d="m8.3 10.7 7.4-4.3M8.3 13.3l7.4 4.3" ${STROKE}/>`,
  link: `<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" ${STROKE}/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" ${STROKE}/>`,
  mail: `<rect x="3" y="5" width="18" height="14" rx="2" ${STROKE}/><path d="m4 7 8 6 8-6" ${STROKE}/>`,
  ticket: `<path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 0 0 4v1a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-1a2 2 0 0 1 0-4 2 2 0 0 1 0-4V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" ${STROKE}/><path d="M15 6v12" ${STROKE} stroke-dasharray="2 2.5"/>`,
  keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2" ${STROKE}/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10" ${STROKE}/>`,
  touch: `<rect x="6" y="2.5" width="12" height="19" rx="2.5" ${STROKE}/><path d="M11 18h2" ${STROKE}/>`,
  gamepad: `<path d="M7 9h3M8.5 7.5v3M15 9h.01M17 11h.01" ${STROKE}/><path d="M6.5 5h11a4 4 0 0 1 4 4.3l-.6 6.4a2.5 2.5 0 0 1-4.4 1.4L14.6 15H9.4l-1.9 2.1a2.5 2.5 0 0 1-4.4-1.4l-.6-6.4A4 4 0 0 1 6.5 5z" ${STROKE}/>`,
  // the groups in "What's in the park"
  loop: `<path d="M2 19c3 0 4-1.5 5.5-4.5C9.6 10.3 11 6 14.5 6 17 6 18.5 8 18.5 10.2c0 2.6-2 4.3-4.3 4.3-2.6 0-4-2.2-3.4-4.6M14.5 14.5C16.6 17.8 18.6 19 22 19" ${STROKE}/><path d="M4 19v2M9 15v6M19 15.5V21" ${STROKE}/>`,
  target: `<circle cx="12" cy="12" r="9" ${STROKE}/><circle cx="12" cy="12" r="5" ${STROKE}/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  flag: `<path d="M5 21V4M5 4h13l-2.5 4L18 12H5" ${STROKE}/>`,
  wrench: `<path d="M14.7 6.3a4 4 0 0 0 5.2 5.2l-8.4 8.4a2.1 2.1 0 0 1-3-3l8.4-8.4a4 4 0 0 1-2.2-2.2z" ${STROKE}/><path d="M14.7 6.3 17 4" ${STROKE}/>`,
  plane: `<path d="M21 15.5v-1.8l-8-4.7V4.2a1.5 1.5 0 0 0-3 0V9l-8 4.7v1.8l8-2.4v4.6L7.8 19.4V21l3.7-1.1 3.7 1.1v-1.6L13 17.7v-4.6z" fill="currentColor"/>`,
  frame: `<rect x="3" y="3" width="18" height="18" rx="1.5" ${STROKE}/><rect x="7" y="7" width="10" height="10" ${STROKE}/><path d="m7 15 3-3 2 2 2-2 3 3" ${STROKE}/>`,
  shirt: `<path d="M8 3 3.5 5.5l1.8 4L7.5 8.6V21h9V8.6l2.2.9 1.8-4L16 3c-.5 1.6-2.1 2.7-4 2.7S8.5 4.6 8 3z" ${STROKE}/>`,
  clock: `<circle cx="12" cy="12" r="9" ${STROKE}/><path d="M12 7v5l3 2" ${STROKE}/>`,
  // brands for the share row and the creator's profiles (simplified marks)
  x: `<path d="M4 4l16 16M20 4 4 20" ${STROKE}/>`,
  facebook: `<path d="M14.5 8.5H17V5h-2.6C11.8 5 10.5 6.6 10.5 9v2H8v3.5h2.5V22H14v-7.5h2.6l.5-3.5H14V9.2c0-.4.2-.7.5-.7z" fill="currentColor"/>`,
  whatsapp: `<path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z" ${STROKE}/><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.6-2-1-1 .8a5 5 0 0 1-2.7-2.7l.8-1-1-2z" fill="currentColor"/>`,
  reddit: `<ellipse cx="12" cy="14.5" rx="7.5" ry="5" ${STROKE}/><circle cx="9.3" cy="14" r="1" fill="currentColor"/><circle cx="14.7" cy="14" r="1" fill="currentColor"/><path d="M9.5 16.6c1.5.9 3.5.9 5 0M12 9.5l1.2-5 3.3.8" ${STROKE}/><circle cx="18" cy="5.6" r="1.4" ${STROKE}/>`,
  linkedin: `<rect x="3" y="3" width="18" height="18" rx="3" ${STROKE}/><path d="M8 10.5V17M8 7.3v.01M11.5 17v-6.5M11.5 13.2c0-1.6 1-2.7 2.4-2.7 1.4 0 2.1 1 2.1 2.7V17" ${STROKE}/>`,
  telegram: `<path d="M21 4 3 11.2l5.6 2 2.2 6.3 3.2-3.9 4.9 3.6z" ${STROKE}/><path d="m8.6 13.2 8.6-6" ${STROKE}/>`,
  github: `<path d="M9 19c-4 1.3-4-2-6-2.5m12 4.5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" ${STROKE}/>`,
};

/** Icons that point in the reading direction, mirrored on /ar. */
const DIRECTIONAL = new Set(['arrow']);

/**
 * An inline icon. Decorative by default (aria-hidden): give the link or button around it a text
 * label. Pass `label` only for an icon that stands alone as an image.
 */
export function icon(name: string, cls = '', label = ''): string {
  const classes = ['icon', `icon-${name}`, DIRECTIONAL.has(name) ? 'icon-dir' : '', cls].filter(Boolean).join(' ');
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="${classes}" viewBox="0 0 24 24" width="24" height="24" ${a11y}>${PATHS[name] ?? ''}</svg>`;
}
