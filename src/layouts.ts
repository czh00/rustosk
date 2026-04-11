export type KeyDefinition = {
  code: number;
  label: string; // Top-Left (Base English)
  sub?: string; // Top-Right (Shift/Symbols)
  fn?: string;  // Bottom-Left (Function keys)
  zhPinyin?: string; // Bottom-Right (Zhuyin)
  special?: boolean;
  class?: string;
  width?: number; // 1 = 1u, 2 = 2u, etc.
  height?: number; // 1 = 1 row, 2 = 2 rows
};

export const compactLayout: KeyDefinition[][] = [
  // Number row
  [
    { code: 0xC0, label: '`', sub: '~', fn: '⎋', class: 'cyan-text' },
    { code: 0x31, label: '1', sub: '!', fn: 'F1', zhPinyin: 'ㄅ' },
    { code: 0x32, label: '2', sub: '@', fn: 'F2', zhPinyin: 'ㄉ' },
    { code: 0x33, label: '3', sub: '#', fn: 'F3', zhPinyin: 'ˇ' },
    { code: 0x34, label: '4', sub: '$', fn: 'F4', zhPinyin: 'ˋ' },
    { code: 0x35, label: '5', sub: '%', fn: 'F5', zhPinyin: 'ㄓ' },
    { code: 0x36, label: '6', sub: '^', fn: 'F6', zhPinyin: 'ˊ' },
    { code: 0x37, label: '7', sub: '&', fn: 'F7', zhPinyin: '˙' },
    { code: 0x38, label: '8', sub: '*', fn: 'F8', zhPinyin: 'ㄚ' },
    { code: 0x39, label: '9', sub: '(', fn: 'F9', zhPinyin: 'ㄞ' },
    { code: 0x30, label: '0', sub: ')', fn: 'F10', zhPinyin: 'ㄢ' },
    { code: 0xBD, label: '-', sub: '_', fn: 'F11', zhPinyin: 'ㄦ' },
    { code: 0xBB, label: '=', sub: '+', fn: 'F12' },
    { code: 0x08, label: '⌫', fn: '⌦', special: true, width: 2.0 }
  ],
  // QWERTY row
  [
    { code: 0x09, label: '⇥', special: true, width: 1.5 },
    { code: 0x51, label: 'q', sub: 'Q', zhPinyin: 'ㄆ' },
    { code: 0x57, label: 'w', sub: 'W', zhPinyin: 'ㄊ' },
    { code: 0x45, label: 'e', sub: 'E', zhPinyin: 'ㄍ' },
    { code: 0x52, label: 'r', sub: 'R', zhPinyin: 'ㄐ' },
    { code: 0x54, label: 't', sub: 'T', zhPinyin: 'ㄔ' },
    { code: 0x59, label: 'y', sub: 'Y', zhPinyin: 'ㄗ' },
    { code: 0x55, label: 'u', sub: 'U', zhPinyin: 'ㄧ' },
    { code: 0x49, label: 'i', sub: 'I', zhPinyin: 'ㄛ' },
    { code: 0x4F, label: 'o', sub: 'O', zhPinyin: 'ㄟ' },
    { code: 0x50, label: 'p', sub: 'P', zhPinyin: 'ㄣ' },
    { code: 0xDB, label: '[', sub: '{', zhPinyin: '「' }, 
    { code: 0xDD, label: ']', sub: '}', zhPinyin: '」' },
    { code: 0xDC, label: '\\', sub: '|', zhPinyin: '、', width: 1.5 }
  ],
  // ASDF row
  [
    { code: 0x14, label: '⇪', special: true, class: 'cyan-text', width: 1.75 },
    { code: 0x41, label: 'a', sub: 'A', zhPinyin: 'ㄇ' },
    { code: 0x53, label: 's', sub: 'S', zhPinyin: 'ㄋ' },
    { code: 0x44, label: 'd', sub: 'D', zhPinyin: 'ㄎ' },
    { code: 0x46, label: 'f', sub: 'F', zhPinyin: 'ㄑ' },
    { code: 0x47, label: 'g', sub: 'G', zhPinyin: 'ㄕ' },
    { code: 0x48, label: 'h', sub: 'H', zhPinyin: 'ㄘ' },
    { code: 0x4A, label: 'j', sub: 'J', zhPinyin: 'ㄨ' },
    { code: 0x4B, label: 'k', sub: 'K', zhPinyin: 'ㄜ' },
    { code: 0x4C, label: 'l', sub: 'L', zhPinyin: 'ㄠ' },
    { code: 0xBA, label: ';', sub: ':', zhPinyin: 'ㄤ' },
    { code: 0xDE, label: "'", sub: '"' },
    { code: 0x0D, label: '⏎', class: 'enter special', width: 2.25 }
  ],
  // ZXCV row
  [
    { code: 0xA0, label: '⇧', special: true, width: 2.5 },
    { code: 0x5A, label: 'z', sub: 'Z', zhPinyin: 'ㄈ' },
    { code: 0x58, label: 'x', sub: 'X', zhPinyin: 'ㄌ' },
    { code: 0x43, label: 'c', sub: 'C', zhPinyin: 'ㄏ' },
    { code: 0x56, label: 'v', sub: 'V', zhPinyin: 'ㄒ' },
    { code: 0x42, label: 'b', sub: 'B', zhPinyin: 'ㄖ' },
    { code: 0x4E, label: 'n', sub: 'N', zhPinyin: 'ㄙ' },
    { code: 0x4D, label: 'm', sub: 'M', zhPinyin: 'ㄩ' },
    { code: 0xBC, label: ',', sub: '<', zhPinyin: 'ㄝ' },
    { code: 0xBE, label: '.', sub: '>', zhPinyin: 'ㄡ' },
    { code: 0xBF, label: '/', sub: '?', zhPinyin: 'ㄥ' },
    { code: 0x26, label: '⇡', fn: '⇞', special: true, width: 1.25 },
    { code: 0xFE, label: '⌨', class: 'cyan-text fn-key special', width: 1.25 }
  ],
  // Space row
  [
    { code: 0xA2, label: '^', special: true, width: 1.25 },
    { code: 0x5B, label: '⊞', special: true, width: 1.25 },
    { code: 0xA4, label: '⌥', special: true, width: 1.25 },
    { code: 0x20, label: '—', class: 'space', width: 6.25 },
    { code: 0x5D, label: 'En', class: 'mode-key special', width: 1.25 },
    { code: 0x25, label: '⇠', fn: '↖', special: true, width: 1.25 },
    { code: 0x28, label: '⇣', fn: '⇟', special: true, width: 1.25 },
    { code: 0x27, label: '⇢', fn: '↘', special: true, width: 1.25 }
  ]
];

export const fullLayout: KeyDefinition[][] = [
  // Full desktop layout with text labels
  // Row 0: Esc, F1-F12, PrtSc, etc.
  [
    { code: 0x1B, label: 'Esc', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 1.0 },
    { code: 0x70, label: 'F1', special: true }, { code: 0x71, label: 'F2', special: true }, { code: 0x72, label: 'F3', special: true }, { code: 0x73, label: 'F4', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.5 },
    { code: 0x74, label: 'F5', special: true }, { code: 0x75, label: 'F6', special: true }, { code: 0x76, label: 'F7', special: true }, { code: 0x77, label: 'F8', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.5 },
    { code: 0x78, label: 'F9', special: true }, { code: 0x79, label: 'F10', special: true }, { code: 0x7A, label: 'F11', special: true }, { code: 0x7B, label: 'F12', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0x2C, label: 'PrtSc', special: true }, { code: 0x91, label: 'ScrLk', special: true }, { code: 0x13, label: 'Pause', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0xAD, label: '🔇', special: true }, { code: 0xAE, label: '🔉', special: true }, { code: 0xAF, label: '🔊', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 1.0 }
  ],
  // Row 1: Number row + Nav keys + Numpad row 0
  [
    { code: 0xC0, label: '`', sub: '~', fn: '°' },
    { code: 0x31, label: '1', sub: '!', fn: 'F1', zhPinyin: 'ㄅ' }, { code: 0x32, label: '2', sub: '@', fn: 'F2', zhPinyin: 'ㄉ' }, { code: 0x33, label: '3', sub: '#', fn: 'F3', zhPinyin: 'ˇ' },
    { code: 0x34, label: '4', sub: '$', fn: 'F4', zhPinyin: 'ˋ' }, { code: 0x35, label: '5', sub: '%', fn: 'F5', zhPinyin: 'ㄓ' }, { code: 0x36, label: '6', sub: '^', fn: 'F6', zhPinyin: 'ˊ' },
    { code: 0x37, label: '7', sub: '&', fn: 'F7', zhPinyin: '˙' }, { code: 0x38, label: '8', sub: '*', fn: 'F8', zhPinyin: 'ㄚ' }, { code: 0x39, label: '9', sub: '(', fn: 'F9', zhPinyin: 'ㄞ' },
    { code: 0x30, label: '0', sub: ')', fn: 'F10', zhPinyin: 'ㄢ' }, { code: 0xBD, label: '-', sub: '_', fn: 'F11', zhPinyin: 'ㄦ' }, { code: 0xBB, label: '=', sub: '+', fn: 'F12' },
    { code: 0x08, label: 'Backspace', special: true, width: 2.0 },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0x2D, label: 'Ins', special: true }, { code: 0x24, label: 'Home', special: true }, { code: 0x21, label: 'PgUp', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0x90, label: 'NumLock', special: true }, { code: 0x6F, label: '/', special: true }, { code: 0x6A, label: '*', special: true }, { code: 0x6D, label: '-', special: true }
  ],
  // Row 2: QWERTY + Nav + Numpad
  [
    { code: 0x09, label: 'Tab', special: true, width: 1.5 },
    { code: 0x51, label: 'q', sub: 'Q', zhPinyin: 'ㄆ' }, { code: 0x57, label: 'w', sub: 'W', zhPinyin: 'ㄊ' }, { code: 0x45, label: 'e', sub: 'E', zhPinyin: 'ㄍ' }, { code: 0x52, label: 'r', sub: 'R', zhPinyin: 'ㄐ' },
    { code: 0x54, label: 't', sub: 'T', zhPinyin: 'ㄔ' }, { code: 0x59, label: 'y', sub: 'Y', zhPinyin: 'ㄗ' }, { code: 0x55, label: 'u', sub: 'U', zhPinyin: 'ㄧ' }, { code: 0x49, label: 'i', sub: 'I', zhPinyin: 'ㄛ' },
    { code: 0x4F, label: 'o', sub: 'O', zhPinyin: 'ㄟ' }, { code: 0x50, label: 'p', sub: 'P', zhPinyin: 'ㄣ' }, { code: 0xDB, label: '[', sub: '{', zhPinyin: '「' }, { code: 0xDD, label: ']', sub: '}', zhPinyin: '」' },
    { code: 0xDC, label: '\\', sub: '|', zhPinyin: '、', width: 1.5 },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0x2E, label: 'Del', special: true }, { code: 0x23, label: 'End', special: true }, { code: 0x22, label: 'PgDn', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0x67, label: '7', sub: 'Home', class: 'num-key' }, { code: 0x68, label: '8', sub: '↑', class: 'num-key' }, { code: 0x69, label: '9', sub: 'PgUp', class: 'num-key' }, { code: 0x6B, label: '+', special: true, height: 2 }
  ],
  // Row 3: ASDF + Numpad
  [
    { code: 0x14, label: 'Caps Lock', special: true, width: 1.75 },
    { code: 0x41, label: 'a', sub: 'A', zhPinyin: 'ㄇ' }, { code: 0x53, label: 's', sub: 'S', zhPinyin: 'ㄋ' }, { code: 0x44, label: 'd', sub: 'D', zhPinyin: 'ㄎ' }, { code: 0x46, label: 'f', sub: 'F', zhPinyin: 'ㄑ' },
    { code: 0x47, label: 'g', sub: 'G', zhPinyin: 'ㄕ' }, { code: 0x48, label: 'h', sub: 'H', zhPinyin: 'ㄘ' }, { code: 0x4A, label: 'j', sub: 'J', zhPinyin: 'ㄨ' }, { code: 0x4B, label: 'k', sub: 'K', zhPinyin: 'ㄜ' },
    { code: 0x4C, label: 'l', sub: 'L', zhPinyin: 'ㄠ' }, { code: 0xBA, label: ';', sub: ':', zhPinyin: 'ㄤ' }, { code: 0xDE, label: "'", sub: '"' },
    { code: 0x0D, label: 'Enter', special: true, width: 2.25 },
    { code: 0, label: '', special: true, class: 'invisible', width: 3.5 },
    { code: 0x64, label: '4', sub: '←', class: 'num-key' }, { code: 0x65, label: '5', sub: '5', class: 'num-key' }, { code: 0x66, label: '6', sub: '→', class: 'num-key' }
  ],
  // Row 4: ZXCV + Up + Numpad
  [
    { code: 0xA0, label: 'Shift', special: true, width: 2.25 },
    { code: 0x5A, label: 'z', sub: 'Z', zhPinyin: 'ㄈ' }, { code: 0x58, label: 'x', sub: 'X', zhPinyin: 'ㄌ' }, { code: 0x43, label: 'c', sub: 'C', zhPinyin: 'ㄏ' }, { code: 0x56, label: 'v', sub: 'V', zhPinyin: 'ㄒ' },
    { code: 0x42, label: 'b', sub: 'B', zhPinyin: 'ㄖ' }, { code: 0x4E, label: 'n', sub: 'N', zhPinyin: 'ㄙ' }, { code: 0x4D, label: 'm', sub: 'M', zhPinyin: 'ㄩ' }, { code: 0xBC, label: ',', sub: '<', zhPinyin: 'ㄝ' },
    { code: 0xBE, label: '.', sub: '>', zhPinyin: 'ㄡ' }, { code: 0xBF, label: '/', sub: '?', zhPinyin: 'ㄥ' },
    { code: 0xA1, label: 'Shift', special: true, width: 2.75 },
    { code: 0, label: '', special: true, class: 'invisible', width: 1.25 },
    { code: 0x26, label: '↑', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 1.25 },
    { code: 0x61, label: '1', sub: 'End', class: 'num-key' }, { code: 0x62, label: '2', sub: '↓', class: 'num-key' }, { code: 0x63, label: '3', sub: 'PgDn', class: 'num-key' }, { code: 0x0D, label: 'Enter', special: true, height: 2 }
  ],
  // Row 5: Space + Navigation + Numpad
  [
    { code: 0xA2, label: 'Ctrl', special: true, width: 1.25 },
    { code: 0x5B, label: 'Win', special: true, width: 1.25 },
    { code: 0xA4, label: 'Alt', special: true, width: 1.25 },
    { code: 0x20, label: 'Space', width: 6.25 },
    { code: 0xA5, label: 'Alt', special: true, width: 1.25 },
    { code: 0x5B, label: 'Win', special: true, width: 1.25 },
    { code: 0x5D, label: 'En', class: 'mode-key special', width: 1.25 },
    { code: 0xA3, label: 'Ctrl', special: true, width: 1.25 },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0x25, label: '←', special: true }, { code: 0x28, label: '↓', special: true }, { code: 0x27, label: '→', special: true },
    { code: 0, label: '', special: true, class: 'invisible', width: 0.25 },
    { code: 0x60, label: '0', sub: 'Ins', width: 2, class: 'num-key' }, { code: 0x6E, label: '.', sub: 'Del', class: 'num-key' }
  ]
];
