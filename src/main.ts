import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { compactLayout, fullLayout, KeyDefinition, CornerOverride } from './layouts';

declare const __APP_VERSION__: string;

const toggledModifiers: number[] = [];
let currentLayout: KeyDefinition[][] = compactLayout;
let isFull = false;
let isDynamic = true;
let isPinned = true;
let isZhuyinMode = false;
let isDark = true;
let isEditMode = false;
let isFirstBoot = false;
let lastCapsStatus = false;
let lastNumStatus = false;

// Drag state for custom D&D
let draggedKey: HTMLElement | null = null;
let ghost: HTMLElement | null = null;
let dragStartX = 0;
let dragStartY = 0;
let currentHoverTarget: HTMLElement | null = null;
// When true, skip the next automatic syncWindowSize() call (used to avoid
// restoring window to default size right after exiting edit mode)
let skipNextSyncWindowSize = false;
let userAdjustedSize = false;
let isProgrammaticResize = false;
let pinnedBackupBeforeEdit: boolean | null = null;


// Custom Key Overrides & Long Press
let longPressTimer: any = null;
let editingKeyPos: string | null = null;
const LONG_PRESS_DURATION = 600;


interface OSKConfig {
    layout: KeyDefinition[][];
    isFull: boolean;
    isDynamic: boolean;
    isPinned: boolean;
    isZhuyinMode?: boolean;
    isDark: boolean;
    rX?: number; // Relative X ratio (0.0 - 1.0)
    rY?: number; // Relative Y ratio (0.0 - 1.0)
    opacity?: number;
    w?: number;  // Window width
    h?: number;  // Window height
}

async function initApp() {
    isFirstBoot = false;

    // 1. 初始化設定載入
    try {
        const isReset = sessionStorage.getItem('reset_pending') === 'true';
        if (isReset) {
            sessionStorage.removeItem('reset_pending');
            isFirstBoot = true;
            userAdjustedSize = false;
            document.documentElement.style.setProperty('--app-scale', '1');
            console.log("Reset detected, forcing first boot defaults");
        }
        
        const savedData = await invoke<string>('load_config');
        const config = JSON.parse(savedData);
        
        if (config && (config.layout || config.isFull !== undefined)) {
            isFull = config.isFull || false;
            currentLayout = config.layout || (isFull ? fullLayout : compactLayout);
            isDynamic = config.isDynamic !== undefined ? Boolean(config.isDynamic) : true;
            isPinned = config.isPinned !== undefined ? Boolean(config.isPinned) : true;
            isZhuyinMode = config.isZhuyinMode !== undefined ? Boolean(config.isZhuyinMode) : false;
            isDark = config.isDark !== undefined ? Boolean(config.isDark) : true;
            
            if (config.rX !== undefined && config.rY !== undefined) {
                 // 暫存座標資訊，待視窗渲染穩定後套用
            } else {
                 isFirstBoot = true;
            }
            
            if (config.opacity !== undefined) {
                const kb = document.getElementById('keyboard');
                if (kb) kb.style.opacity = config.opacity.toString();
                const slider = document.getElementById('opacity-slider') as HTMLInputElement;
                if (slider) slider.value = config.opacity.toString();
            }
        }
    } catch (e) {
        console.log("No config, loading defaults");
        isFirstBoot = true;
    }

    // 2. 根據確定後的設定進行渲染
    renderKeys();
    setupToolbar(); 
    setupLockPolling();

    // 3. 套用配色並同步 UI
    applyTheme(isDark);
    syncUIState();
    updateKeyboardDynamicMod();

    // 4. 同步視窗標籤與外部狀態
    try {
        const window = getCurrentWindow();
        await window.setTitle(`rustosk`);
    } catch (e) { console.error(e); }
    
    try {
        // 如果是重置，確保後端也同步狀態
        if (isFirstBoot) {
            isPinned = true;
            isDynamic = true;
            await invoke('set_pinned', { pinned: true });
            await invoke('set_dynamic_display', { enabled: true });
        } else {
            await invoke('set_pinned', { pinned: isPinned });
            await invoke('set_dynamic_display', { enabled: isDynamic });
        }
        await checkAndSyncLocks();
    } catch (e) { console.error("Sync state failed:", e); }

    // 5. 視窗定位與尺寸同步
    setTimeout(async () => {
        const isReset = isFirstBoot; // 如果是重置，確保執行強制縮放 1.0 並重置 userAdjustedSize
        if (isReset) {
            userAdjustedSize = false;
            document.documentElement.style.setProperty('--app-scale', '1');
        }

        const savedData = await invoke<string>('load_config').catch(() => "{}");
        const config = JSON.parse(savedData);
        if (config.w && config.h && !isReset) {
            await invoke('resize_window', { width: config.w, height: config.h });
        }
        if (config.rX !== undefined && config.rY !== undefined && !isFirstBoot) {
             await invoke('apply_relative_pos', { rx: config.rX, ry: config.rY });
        }
        await syncWindowSize(isReset); // 如果是重置，強制同步
    }, 100);
}

function syncUIState() {
    const getIntegratedTip = (el: HTMLElement | null, status: string) => {
        if (!el) return "";
        let base = el.getAttribute('data-tip-base');
        if (base === null) {
            base = el.getAttribute('data-tip') || "";
            el.setAttribute('data-tip-base', base);
        }
        return base ? `${base} ➔ ${status}` : status;
    };

    // 圖釘鈕 (btn-pin) 維持現狀 (狀態型)
    const btnPin = document.getElementById('btn-pin');
    if (btnPin) {
        btnPin.innerHTML = isPinned ? '📍' : '📌';
        btnPin.setAttribute('data-tip', getIntegratedTip(btnPin, isPinned ? '目前為固定 (點擊解除)' : '目前為自動隱藏 (點擊固定)'));
        btnPin.classList.remove('active-tool');
    }
    
    // 以下為預覽型邏輯 (顯示「點擊後將變成的狀態」)
    const btnDynamic = document.getElementById('btn-dynamic');
    if (btnDynamic) {
        btnDynamic.innerHTML = isDynamic ? '🗖' : '🗔';
        btnDynamic.setAttribute('data-tip', getIntegratedTip(btnDynamic, isDynamic ? '切換至靜態顯示' : '切換至動態顯示'));
        btnDynamic.classList.toggle('active-tool', isDynamic);
    }
    
    const btnLayout = document.getElementById('btn-layout');
    if (btnLayout) {
        btnLayout.innerHTML = isFull ? '📱' : '💻';
        btnLayout.setAttribute('data-tip', getIntegratedTip(btnLayout, isFull ? '切換回精簡版面' : '切換至全鍵盤版面'));
        btnLayout.classList.toggle('active-tool', isFull);
    }
    
    const btnTheme = document.getElementById('btn-theme');
    if (btnTheme) {
        // 預覽型邏輯：深色時(isDark=true)顯示太陽☀️(點擊變亮)，淺色時(isDark=false)顯示月亮🌙(點擊變暗)
        btnTheme.innerHTML = isDark ? '☀️' : '🌙'; 
        btnTheme.setAttribute('data-tip', getIntegratedTip(btnTheme, isDark ? '切換至淺色模式' : '切換至深色模式'));
    }

    const btnEdit = document.getElementById('btn-edit');
    if (btnEdit) {
        btnEdit.innerHTML = isEditMode ? '👁️' : '⚙'; // 編輯時顯示眼睛(預告點擊變觀看)
        btnEdit.setAttribute('data-tip', getIntegratedTip(btnEdit, isEditMode ? '返回觀看模式' : '開啟編輯模式'));
        btnEdit.classList.toggle('active-tool', isEditMode);
        document.body.classList.toggle('edit-mode', isEditMode);
    }
    
    refreshActiveTooltip();
    
    // 同步佈局樣式類別
    const kb = document.getElementById('keyboard');
    if (kb) {
        if (isFull) kb.classList.add('full-keyboard');
        else kb.classList.remove('full-keyboard');
    }
}

function setupLockPolling() {
    setInterval(async () => {
        await checkAndSyncLocks();
    }, 200);
}

async function checkAndSyncLocks() {
    try {
        const [caps, num] = await invoke<[boolean, boolean]>('get_locks');
        let changed = false;
        
        if (caps !== lastCapsStatus) {
            updateLockUI(0x14, caps);
            lastCapsStatus = caps;
            changed = true;
        }
        
        if (num !== lastNumStatus) {
            updateLockUI(0x90, num);
            lastNumStatus = num;
            changed = true;
        }

        // 僅在任一鎖定鍵狀態改變時才觸發全域更新
        if (changed) {
            updateKeyboardDynamicMod();
        }
    } catch (e) { }
}

function updateLockUI(vk: number, isActive: boolean) {
    const isToggled = toggledModifiers.includes(vk);
    if (isActive && !isToggled) {
        toggledModifiers.push(vk);
    } else if (!isActive && isToggled) {
        const idx = toggledModifiers.indexOf(vk);
        if (idx > -1) toggledModifiers.splice(idx, 1);
    }
    
    document.querySelectorAll(`.key[data-vk="${vk}"]`).forEach((el: any) => {
        if (isActive) el.classList.add('active-toggle');
        else el.classList.remove('active-toggle');
    });
}

async function saveCurrentConfig() {
    try {
        const relPos = await invoke<[number, number]>('get_relative_pos');
        const window = getCurrentWindow();
        const physicalSize = await window.outerSize();
        const scaleFactor = await window.scaleFactor();
        
        const config: OSKConfig = {
            layout: currentLayout,
            isFull: isFull,
            isDynamic: isDynamic,
            isPinned: isPinned,
            isZhuyinMode: isZhuyinMode,
            isDark: isDark,
            rX: relPos[0],
            rY: relPos[1],
            opacity: parseFloat((document.getElementById('opacity-slider') as HTMLInputElement).value || "1"),
            w: physicalSize.width / scaleFactor,
            h: physicalSize.height / scaleFactor
        };
        await invoke('save_config', { data: JSON.stringify(config) });
    } catch (e) {
        console.error("Failed to save config", e);
    }
}

function getAutoFontSize(text: string, baseSize: number): string {
    if (!text) return `${baseSize}px`;
    const len = text.length;
    if (len <= 2) return `${baseSize}px`;
    if (len <= 4) return `${Math.floor(baseSize * 0.85)}px`;
    if (len <= 6) return `${Math.floor(baseSize * 0.75)}px`;
    return `${Math.floor(baseSize * 0.65)}px`;
}

function renderKeys() {
  const container = document.getElementById('keys-container');
  if (!container || !currentLayout.length) return;
  container.innerHTML = '';

  currentLayout.forEach((rowData: KeyDefinition[], rowIndex: number) => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';

    rowData.forEach((key, colIndex) => {
      const btn = document.createElement('div');
      let classes = ['key'];
      if (key.special) classes.push('special');
      if (key.class) classes.push(key.class);
      if (isEditMode) classes.push('edit-target');
      const isAlpha = key.label.length === 1 && /^[a-zA-Z]$/.test(key.label);
      if (isAlpha) classes.push('alpha-key');
      if (!isAlpha && key.sub) classes.push('symbol-key');
      
      // 標註角落標籤按鍵
      if (key.sub || key.fn || key.zhPinyin || isAlpha) {
          classes.push('has-corners');
      }
      
      btn.className = classes.join(' ');
      btn.dataset.vk = key.code.toString();
      btn.dataset.pos = `${rowIndex},${colIndex}`;

      const isShift = toggledModifiers.includes(0xA0) || toggledModifiers.includes(0xA1);
      const isFn = toggledModifiers.includes(0xFE);
      const isCaps = toggledModifiers.includes(0x14);

      const w = key.width || 1;
      
      // 設定按鈕尺寸與網格跨度
      if (isFull) {
          const gridSpan = Math.round(w * 12);
          btn.style.gridColumn = `span ${gridSpan}`;
          
          if (key.height === 2) {
              btn.style.gridRow = `${rowIndex + 1} / span 2`;
          } else {
              btn.style.gridRow = `${rowIndex + 1}`;
          }
          
          btn.style.width = '100%'; 
          btn.style.flex = 'none';
      } else {
          let widthPx = Math.round(w * 47) - 5;
          btn.style.flex = `0 0 ${widthPx}px`;
          btn.style.width = `${widthPx}px`;
          btn.style.gridColumn = '';
          btn.style.gridRow = '';
      }

      const isNum = toggledModifiers.includes(0x90);
      let displayLabel = key.label;
      let labelClass = '';

      // 功能鍵模式切換提示邏輯
      if (key.code === 0x5D) { // 注音切換
          displayLabel = isZhuyinMode ? 'En' : 'ㄅ';
          labelClass = isZhuyinMode ? '' : 'color-zh';
      } else if (key.code === 0xFE) { // Fn
          labelClass = isFn ? '' : 'color-fn';
      } else if (key.code === 0xA0 || key.code === 0xA1) { // Shift
          labelClass = isShift ? '' : 'color-shift';
      } else if (key.code === 0x90) { // NumLock
          labelClass = isNum ? '' : 'color-num';
      }
      // 靜態模式下 TL corner 的大寫邏輯 (不管 Shift 都要顯示主要標籤)
      // displayLabel 保持 key.label (大寫) 即可


      let tlStyle = `font-size: ${getAutoFontSize(displayLabel, 13)};`;
      if (displayLabel.length >= 5) {
          tlStyle += ' left: 4px;';
      } else if (displayLabel.length >= 4) {
          tlStyle += ' left: 4px; letter-spacing: -0.5px;';
      } else if (displayLabel.length >= 3) {
          tlStyle += ' left: 5px; letter-spacing: -0.25px;';
      }
      
      let inner = '';
      if (key.class?.includes('num-key')) {
          // Numpad 翻轉邏輯：導覽鍵字串顯示於左上，數字顯示於右下
          const navStr = key.sub || key.label;
          const numStr = key.label;
          let tlNavStyle = `font-size: ${getAutoFontSize(navStr, 13)};`;
          if (navStr.length >= 3) tlNavStyle += ' left: 4px;';
          inner += `<span class="tl" style="${tlNavStyle}">${navStr}</span>`;
          inner += `<span class="br ${labelClass}" style="font-size: ${getAutoFontSize(numStr, 10)}">${numStr}</span>`;
      } else {
          const tlDisp = key.tl_ov?.display || displayLabel;
          const trDisp = key.tr_ov?.display || key.sub;
          const blDisp = key.bl_ov?.display || key.fn;
          const brDisp = key.br_ov?.display || key.zhPinyin;

          inner = `<span class="tl ${labelClass}" style="font-size: ${getAutoFontSize(tlDisp, 13)}">${tlDisp}</span>`;
          if (trDisp) inner += `<span class="tr" style="font-size: ${getAutoFontSize(trDisp, 10)}">${trDisp}</span>`;
          if (blDisp) inner += `<span class="bl" style="font-size: ${getAutoFontSize(blDisp, 10)}">${blDisp}</span>`;
          if (brDisp) inner += `<span class="br" style="font-size: ${getAutoFontSize(brDisp, 10)}">${brDisp}</span>`;
      }
      
      // 中央動態標籤邏輯
      let centerChar = key.label;
      let centerClass = '';
      
      // 處理功能鍵本身的提示配色
      if (key.code === 0x5D) { // 注音切換
          centerChar = isZhuyinMode ? 'En' : 'ㄅ';
          centerClass = isZhuyinMode ? '' : 'color-zh';
      } else if (key.code === 0xFE) { // Fn 鍵本身
          centerClass = isFn ? '' : 'color-fn';
      } else if (key.code === 0xA0 || key.code === 0xA1) { // Shift 鍵本身
          centerClass = isShift ? '' : 'color-shift';
      } else if (key.code === 0x90) { // NumLock 鍵本身
          centerClass = isNum ? '' : 'color-num';
      }

      if (isFn && key.fn) {
          centerChar = key.fn;
          if (centerClass === '') centerClass = 'color-fn';
      } else if (isShift) {
          centerChar = key.sub || (isAlpha ? key.label.toUpperCase() : key.label);
          // 只有字母或具備符號的非功能鍵才套用 Shift 配色
          const isSymbolKey = !isAlpha && key.sub && !key.class?.includes('num-key');
          if (isAlpha || isSymbolKey) {
              if (centerClass === '') centerClass = 'color-shift';
          }
      } else if (isZhuyinMode && key.zhPinyin) {
          centerChar = key.zhPinyin;
          if (centerClass === '') centerClass = 'color-zh';
      } else if (isCaps && isAlpha) {
          centerChar = key.label.toUpperCase();
          centerClass = 'color-shift';
      } else if (key.class?.includes('num-key')) {
          // 數字鍵盤切換：當 NumLock 開啟時顯示數字，關閉時顯示導覽鍵
          if (isNum) {
              centerChar = key.label;
              centerClass = 'color-num';
          } else {
              centerChar = key.sub || key.label;
              centerClass = '';
          }
      } else if ((key.code >= 0x60 && key.code <= 0x69) || key.code === 0x6E) { // 僅數字與小數點
          centerClass = 'color-num';
      } else if (!key.special) {
          centerChar = key.label.toLowerCase();
      }

      if (key.code === 0x5D) {
          // 預覽型標籤
          centerChar = (isZhuyinMode ? 'En' : 'ㄅ');
      } else if (key.special && !isDynamic) {
          // 靜態模式下的功能鍵處理
          centerChar = displayLabel;
      }

      // --- Use Override Display for Center Label if applicable ---
      if (isFn && key.bl_ov?.display) centerChar = key.bl_ov.display;
      else if (isShift && key.tr_ov?.display) centerChar = key.tr_ov.display;
      else if (isZhuyinMode && key.br_ov?.display) centerChar = key.br_ov.display;
      else if (key.tl_ov?.display) centerChar = key.tl_ov.display;

      inner += `<span class="center-label ${centerClass}" style="font-size: ${getAutoFontSize(centerChar, 24)}">${centerChar}</span>`;
      btn.innerHTML = inner;

      // 支援跨行渲染 (九宮格 + 與 Enter)
      if (key.height === 2) {
          btn.classList.add('span-2-rows');
          btn.style.zIndex = '10';
      }
      
      // 自動字體縮放檢查
      requestAnimationFrame(() => {
          const centerLabel = btn.querySelector('.center-label') as HTMLElement;
          if (centerLabel) {
              const maxW = btn.clientWidth - 8;
              if (centerLabel.scrollWidth > maxW) {
                  let fontSize = 24;
                  while (centerLabel.scrollWidth > maxW && fontSize > 8) {
                      fontSize--;
                      centerLabel.style.fontSize = `${fontSize}px`;
                  }
              }
          }
      });

      if (toggledModifiers.includes(key.code)) btn.classList.add('active-toggle');

      btn.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!isEditMode) {
          handleKeyPress(btn, key);
          return;
        }

        // --- Long-press detection for Editing ---
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            editingKeyPos = btn.dataset.pos || null;
            openKeyEditor(key);
            cleanupDrag(); // Cancel any ongoing drag
        }, LONG_PRESS_DURATION);

        const rect = btn.getBoundingClientRect();
        dragStartX = e.clientX - rect.left;
        dragStartY = e.clientY - rect.top;
        draggedKey = btn;
        btn.classList.add('dragging');
        
        ghost = btn.cloneNode(true) as HTMLElement;
        ghost.classList.add('key-ghost');
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        ghost.style.left = rect.left + 'px';
        ghost.style.top = rect.top + 'px';
        document.body.appendChild(ghost);
        btn.setPointerCapture(e.pointerId);
      });

      btn.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isEditMode || !draggedKey || !ghost) return;

        // If moved significantly, cancel long-press
        if (longPressTimer) {
            const rect = draggedKey.getBoundingClientRect();
            const dx = Math.abs(e.clientX - (rect.left + dragStartX));
            const dy = Math.abs(e.clientY - (rect.top + dragStartY));
            if (dx > 5 || dy > 5) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }

        if (!longPressTimer) { // Only drag if NOT in a long-press wait
            ghost.style.left = (e.clientX - dragStartX) + 'px';
            ghost.style.top = (e.clientY - dragStartY) + 'px';
            
            const target = getDropTarget(e.clientX, e.clientY);
            document.querySelectorAll('.key').forEach(k => k.classList.remove('drag-over'));
            if (target && target !== draggedKey) target.classList.add('drag-over');
        }
      });

      btn.addEventListener('pointerup', (e: PointerEvent) => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        if (!isEditMode) {
            handleKeyRelease(btn, key);
            return;
        }
        if (!draggedKey) return;
        const target = getDropTarget(e.clientX, e.clientY);
        if (target && target !== draggedKey) {
            swapKeys(draggedKey.dataset.pos!, target.dataset.pos!);
        }
        cleanupDrag();
      });

      rowDiv.appendChild(btn);
    });
    container.appendChild(rowDiv);
  });
  
  syncWindowSize();
}

const fnKeyMap: Record<string, number> = {
    '⇞': 0x21, // Page Up
    '⇟': 0x22, // Page Down
    '↖': 0x24, // Home
    '↘': 0x23, // End
    '⎋': 0x1B, // Esc (VK_ESCAPE)
    '⌦': 0x2E, // Delete (VK_DELETE)
};

const MODIFIER_NAME_MAP: Record<string, number> = {
    'ctrl': 0x11, 'control': 0x11,
    'shift': 0x10,
    'alt': 0x12, 'menu': 0x12,
    'win': 0x5B, 'lwin': 0x5B, 'rwin': 0x5C, 'cmd': 0x5B,
};

function parseKeyValue(input: string): number[] {
    if (!input) return [];
    // Handle combinations like "Ctrl+C"
    if (input.includes('+')) {
        return input.split('+').map(part => {
            const trimmed = part.trim().toLowerCase();
            if (MODIFIER_NAME_MAP[trimmed]) return MODIFIER_NAME_MAP[trimmed];
            return parseSingleKey(trimmed);
        }).filter(v => v > 0);
    }
    return [parseSingleKey(input.trim().toLowerCase())].filter(v => v > 0);
}

function parseSingleKey(input: string): number {
    if (input.startsWith('0x')) return parseInt(input, 16);
    if (/^\d+$/.test(input)) return parseInt(input, 10);
    if (MODIFIER_NAME_MAP[input]) return MODIFIER_NAME_MAP[input];
    if (input.length === 1) return input.toUpperCase().charCodeAt(0);
    // Common names
    const names: Record<string, number> = {
        'enter': 0x0D, 'tab': 0x09, 'esc': 0x1B, 'space': 0x20, 
        'backspace': 0x08, 'del': 0x2E, 'delete': 0x2E,
        'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27
    };
    return names[input] || 0;
}

function getDefaultKeyValue(key: KeyDefinition, corner: 'tl'|'tr'|'bl'|'br'): string {
    if (corner === 'tl') return `0x${key.code.toString(16)}`;
    if (corner === 'tr') return key.sub ? `Shift+0x${key.code.toString(16)}` : ""; 
    if (corner === 'bl') {
        if (!key.fn) return "";
        if (key.fn.startsWith('F')) {
            const fNum = parseInt(key.fn.substring(1));
            return `0x${(0x6F + fNum).toString(16)}`;
        }
        if (fnKeyMap[key.fn]) return `0x${fnKeyMap[key.fn].toString(16)}`;
        // For special keys, bl often is empty unless defined, but we can default to TL if requested.
        // User said specifically Ctrl/Alt/Arrows, those usually have TL values.
        return "";
    }
    return "";
}

function openKeyEditor(key: KeyDefinition) {
    const modal = document.getElementById('key-editor-modal');
    if (!modal) return;
    
    (document.getElementById('edit-tl-display') as HTMLInputElement).value = key.tl_ov?.display || key.label || "";
    (document.getElementById('edit-tl-value') as HTMLInputElement).value = key.tl_ov?.value || getDefaultKeyValue(key, 'tl');

    (document.getElementById('edit-tr-display') as HTMLInputElement).value = key.tr_ov?.display || key.sub || "";
    (document.getElementById('edit-tr-value') as HTMLInputElement).value = key.tr_ov?.value || getDefaultKeyValue(key, 'tr');

    (document.getElementById('edit-bl-display') as HTMLInputElement).value = key.bl_ov?.display || key.fn || "";
    (document.getElementById('edit-bl-value') as HTMLInputElement).value = key.bl_ov?.value || getDefaultKeyValue(key, 'bl');

    (document.getElementById('edit-br-display') as HTMLInputElement).value = key.br_ov?.display || key.zhPinyin || "";
    (document.getElementById('edit-br-value') as HTMLInputElement).value = key.br_ov?.value || "";

    modal.classList.add('active');
}

function closeKeyEditor() {
    document.getElementById('key-editor-modal')?.classList.remove('active');
    editingKeyPos = null;
}

async function saveKeyLabels() {
    if (!editingKeyPos) return;
    const [r, c] = editingKeyPos.split(',').map(Number);
    const key = currentLayout[r][c];
    
    const getVal = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
    
    key.tl_ov = { display: getVal('edit-tl-display'), value: getVal('edit-tl-value') };
    key.tr_ov = { display: getVal('edit-tr-display'), value: getVal('edit-tr-value') };
    key.bl_ov = { display: getVal('edit-bl-display'), value: getVal('edit-bl-value') };
    key.br_ov = { display: getVal('edit-br-display'), value: getVal('edit-br-value') };

    renderKeys();
    await saveCurrentConfig();
    closeKeyEditor();
}

async function handleKeyPress(btn: HTMLElement, key: KeyDefinition) {
    btn.classList.add('active');

    // --- Check for Overrides first ---
    const isShift = toggledModifiers.includes(0xA0) || toggledModifiers.includes(0xA1);
    const isFn = toggledModifiers.includes(0xFE);
    
    let override: CornerOverride | undefined;
    if (isFn && key.bl_ov?.value) override = key.bl_ov;
    else if (isShift && key.tr_ov?.value) override = key.tr_ov;
    else if (isZhuyinMode && key.br_ov?.value) override = key.br_ov;
    else if (key.tl_ov?.value) override = key.tl_ov;

    if (override) {
        const vks = parseKeyValue(override.value);
        if (vks.length > 1) {
            await invoke('simulate_combination', { vkCodes: vks });
            return;
        } else if (vks.length === 1) {
            invoke('simulate_key', { vkCode: vks[0], isKeyUp: false });
            return;
        }
    }

    const isModifier = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0xFE].includes(key.code);
    if (isModifier) {
      const idx = toggledModifiers.indexOf(key.code);
      if (idx > -1) { 
        toggledModifiers.splice(idx, 1);
        btn.classList.remove('active-toggle');
        if (key.code !== 0xFE) {
            if (key.code === 0xA4 || key.code === 0xA5) {
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: false });
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: true });
            }
            invoke('simulate_key', { vkCode: key.code, isKeyUp: true });
        }
      } else { 
        toggledModifiers.push(key.code);
        btn.classList.add('active-toggle');
        if (key.code !== 0xFE) invoke('simulate_key', { vkCode: key.code, isKeyUp: false });
      }
      updateKeyboardDynamicMod();
      return;
    }

    if (key.code === 0x5D) {
       invoke('simulate_key', { vkCode: 0xA0, isKeyUp: false });
       setTimeout(() => invoke('simulate_key', { vkCode: 0xA0, isKeyUp: true }), 50);
       return;
    }

    let targetVk = key.code;
    if (isFn && key.fn) {
        if (key.fn.startsWith('F')) {
            const fNum = parseInt(key.fn.substring(1));
            targetVk = 0x6F + fNum;
        } else if (fnKeyMap[key.fn]) {
            targetVk = fnKeyMap[key.fn];
        }
    }

    invoke('simulate_key', { vkCode: targetVk, isKeyUp: false });
}

async function handleKeyRelease(btn: HTMLElement, key: KeyDefinition) {
    btn.classList.remove('active');
    const isModifier = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0xFE].includes(key.code);
    if (!isModifier) {
      if (key.code === 0x5D) return; 

      // --- Handle Release for Overrides ---
      const isShift = toggledModifiers.includes(0xA0) || toggledModifiers.includes(0xA1);
      const isFn = toggledModifiers.includes(0xFE);
      let override: CornerOverride | undefined;
      if (isFn && key.bl_ov?.value) override = key.bl_ov;
      else if (isShift && key.tr_ov?.value) override = key.tr_ov;
      else if (isZhuyinMode && key.br_ov?.value) override = key.br_ov;
      else if (key.tl_ov?.value) override = key.tl_ov;

      if (override) {
          const vks = parseKeyValue(override.value);
          if (vks.length > 1) {
              return; 
          } else if (vks.length === 1) {
              await invoke('simulate_key', { vkCode: vks[0], isKeyUp: true });
              return;
          }
      }

      let targetVk = key.code;
      if (isFn && key.fn) {
          if (key.fn.startsWith('F')) {
              const fNum = parseInt(key.fn.substring(1));
              targetVk = 0x6F + fNum;
          } else if (fnKeyMap[key.fn]) {
              targetVk = fnKeyMap[key.fn];
          }
      }

      await invoke('simulate_key', { vkCode: targetVk, isKeyUp: true });
      
      if (key.code === 0x90 || key.code === 0x14) {
          await checkAndSyncLocks();
      }
      
      const isAltTab = key.code === 0x09 && (toggledModifiers.includes(0xA4) || toggledModifiers.includes(0xA5));

      for (const mod of toggledModifiers) {
         if (mod !== 0xFE && mod !== 0x14 && mod !== 0x90) {
            if (isAltTab && (mod === 0xA4 || mod === 0xA5)) continue;
            if (mod === 0xA4 || mod === 0xA5) {
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: false });
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: true });
            }
            invoke('simulate_key', { vkCode: mod, isKeyUp: true });
         }
      }
      
      if (!isAltTab) {
          invoke('release_all_modifiers');
      }

      for (let i = toggledModifiers.length - 1; i >= 0; i--) {
          const modInfo = toggledModifiers[i];
          if (modInfo !== 0x14 && modInfo !== 0x90 && modInfo !== 0xFE) {
              if (isAltTab && (modInfo === 0xA4 || modInfo === 0xA5)) continue;
              toggledModifiers.splice(i, 1);
          }
      }
      
      document.querySelectorAll('.active-toggle').forEach((el: any) => {
          const vk = el.dataset.vk;
          if (vk !== "20" && vk !== "144" && vk !== "254") {
              if (isAltTab && (vk === "164" || vk === "165")) return;
              el.classList.remove('active-toggle');
          }
      });
      updateKeyboardDynamicMod();
    }
}

function getDropTarget(x: number, y: number): HTMLElement | null {
    if (ghost) ghost.style.pointerEvents = 'none';
    const elements = document.elementsFromPoint(x, y);
    for (const el of elements) {
        if (el.classList.contains('key') && !el.classList.contains('key-ghost')) return el as HTMLElement;
    }
    return null;
}

function cleanupDrag() {
    if (draggedKey) draggedKey.classList.remove('dragging');
    draggedKey = null;
    if (ghost) ghost.remove();
    ghost = null;
    document.querySelectorAll('.key').forEach(k => k.classList.remove('drag-over'));
}

async function swapKeys(pos1: string, pos2: string) {
    const [r1, c1] = pos1.split(',').map(Number);
    const [r2, c2] = pos2.split(',').map(Number);
    const k1 = currentLayout[r1][c1];
    const k2 = currentLayout[r2][c2];

    // 分離「功能/內容」屬性與「物理/佈局」屬性
    const getContent = (k: any) => ({
        code: k.code,
        label: k.label,
        sub: k.sub,
        fn: k.fn,
        zhPinyin: k.zhPinyin,
        tl_ov: k.tl_ov,
        tr_ov: k.tr_ov,
        bl_ov: k.bl_ov,
        br_ov: k.br_ov
    });

    const getLayout = (k: any) => ({
        width: k.width,
        height: k.height,
        special: k.special // 通常 special 跟隨佈局 (如 invisible)
    });

    // 類別處理：
    // 功能性類別 (隨內容走)
    const functionalClasses = ['num-key', 'cyan-text', 'mode-key', 'fn-key', 'alpha-key', 'symbol-key'];
    // 佈局性類別 (留在原地)
    const layoutClasses = ['invisible', 'space', 'enter'];

    const splitClass = (cls: string = "") => {
        const parts = cls.split(' ').filter(c => c && c !== 'key' && c !== 'dragging' && c !== 'drag-over' && c !== 'edit-target');
        return {
            functional: parts.filter(p => functionalClasses.includes(p)),
            layout: parts.filter(p => layoutClasses.includes(p))
        };
    };

    const content1 = getContent(k1);
    const content2 = getContent(k2);
    const l1 = getLayout(k1);
    const l2 = getLayout(k2);
    const cls1 = splitClass(k1.class);
    const cls2 = splitClass(k2.class);

    // 套用交換：新的 k1 = k2 的內容 + k1 的佈局
    currentLayout[r1][c1] = {
        ...content2,
        ...l1,
        class: ['key', ...cls1.layout, ...cls2.functional].filter(Boolean).join(' ')
    };

    // 新的 k2 = k1 的內容 + k2 的佈局
    currentLayout[r2][c2] = {
        ...content1,
        ...l2,
        class: ['key', ...cls2.layout, ...cls1.functional].filter(Boolean).join(' ')
    };
    
    renderKeys();
    await saveCurrentConfig();
}

function updateKeyboardDynamicMod() {
    syncUIState(); // 確保 UI 容器狀態與變數同步
    const kb = document.getElementById('keyboard');
    const container = document.getElementById('keys-container');
    if (!kb || !container) return;
    
    kb.classList.remove('mod-shift', 'mod-fn', 'mod-zh', 'mod-num', 'mod-caps');
    container.classList.toggle('dynamic-labels', isDynamic);
    
    const hasShift = toggledModifiers.includes(0xA0) || toggledModifiers.includes(0xA1);
    const hasFn = toggledModifiers.includes(0xFE);
    const hasNum = toggledModifiers.includes(0x90);
    const hasCaps = toggledModifiers.includes(0x14);
    
    if (hasFn) kb.classList.add('mod-fn');
    if (hasShift) kb.classList.add('mod-shift');
    if (isZhuyinMode) kb.classList.add('mod-zh');
    if (hasNum) kb.classList.add('mod-num');
    if (hasCaps) kb.classList.add('mod-caps');
    
    // 同步渲染
    renderKeys();
    
    // 計算縮放前先更新佈局基準寬度
    const baseWidth = isFull ? 1078 : 723;
    document.documentElement.style.setProperty('--base-width', `${baseWidth}px`);
    
    updateAppScale();
}

/**
 * 計算並套用 CSS 縮放係數，讓鍵盤內容隨視窗大小調整
 * 使用邏輯像素 (Logical Pixels) 以避免在高 DPI 螢幕上發生雙重縮放
 */
function updateAppScale() {
    // 如果正在進行程式化調整或剛重置，暫不根據當前視窗寬度重算比例
    if (isProgrammaticResize || isFirstBoot) return;
    
    const kb = document.getElementById('keyboard');
    if (!kb) return;

    // 使用標準 Web API 的 window.innerWidth，這已是邏輯像素
    const logicalWidth = window.innerWidth;
    
    // 基準寬度
    const baseWidth = isFull ? 1078 : 723;
    const scale = logicalWidth / baseWidth;
    
    document.documentElement.style.setProperty('--app-scale', scale.toString());
}

async function syncWindowSize(force = false) {
    const kb = document.getElementById('keyboard');
    if (!kb) return;
    
    // 編輯模式下通常不自動重設視窗尺寸，除非佈局切換強制同步
    if (isEditMode && !force) return;
    // 如果使用者手動調整過尺寸，則停止自動重置
    if (userAdjustedSize && !force) return;
    // If flagged, skip a single automatic sync to avoid restoring defaults
    if (skipNextSyncWindowSize && !force) { skipNextSyncWindowSize = false; return; }
    
    requestAnimationFrame(async () => {
        
        // 讀取目前的縮放比例，用於維持按鍵視覺大小一致
        const currentScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
        
        // 使用 scrollHeight 取得鍵盤內容真實高度 (scrollHeight 是未經 CSS 縮放的原始高度)
        const naturalHeight = kb.scrollHeight;
        
        // 使用佈局基準寬度
        const naturalWidth = isFull ? 1078 : 723;
        
        // 計算實際視窗尺寸，採比例維持型同步，確保切換版面後按鍵視覺尺寸一致
        const width = Math.ceil(naturalWidth * currentScale);
        const height = Math.ceil(naturalHeight * currentScale) + 4; 
        
        // 標記目前正在程式調整大小，防止觸發 userAdjustedSize
        isProgrammaticResize = true;
        try {
            await invoke('update_aspect_ratio', { width, height });
            await invoke('resize_and_recenter', { width, height, forceCenter: isFirstBoot });
        } finally {
            // 給予短暫延遲確保 resize 事件已被處理
            setTimeout(() => { isProgrammaticResize = false; }, 100);
        }
        
        if (isFirstBoot) {
            isFirstBoot = false; 
            await saveCurrentConfig();
        }
    });
}

async function setupToolbar() {
    const btnLayout = document.getElementById('btn-layout');
    const btnDynamic = document.getElementById('btn-dynamic');
    const btnPin = document.getElementById('btn-pin');
    const btnTheme = document.getElementById('btn-theme');
    const btnEdit = document.getElementById('btn-edit');
    const btnReset = document.getElementById('btn-reset');
    const btnSos = document.getElementById('btn-sos');
    const btnClose = document.getElementById('btn-close');
    const opacitySlider = document.getElementById('opacity-slider') as HTMLInputElement;
    const keyboardNode = document.getElementById('keyboard');
    setupTooltips();
    
    btnLayout?.classList.toggle('active-tool', isFull);
    if (btnPin) {
        btnPin.classList.remove('active-tool');
        btnPin.innerHTML = isPinned ? '📍' : '📌';
    }

    btnLayout?.addEventListener('click', async () => {
        isFull = !isFull;
        currentLayout = isFull ? fullLayout : compactLayout;
        
        // 切換佈局時，獲取目前的 scale 並標記為 userAdjustedSize 以維持比例
        const currentScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
        userAdjustedSize = true; 
        
        const baseWidth = isFull ? 1078 : 723;
        document.documentElement.style.setProperty('--base-width', `${baseWidth}px`);
        
        syncUIState(); 
        renderKeys();
        
        // 更新當前比例，確保佈局切換後視覺大小一致
        document.documentElement.style.setProperty('--app-scale', currentScale.toString());
        
        // 執行多步同步，傳入 force=true 以確保即便在縮放狀態下也能正確計算新版面的寬高
        [100, 300, 600].forEach(delay => setTimeout(() => syncWindowSize(true), delay));
        setTimeout(saveCurrentConfig, 1000);
    });

    btnReset?.addEventListener('click', async () => {
        if (confirm("確定要將所有佈局、位置與透明度恢復為預設值嗎？")) {
            try {
                // 1. 清除 Rust 端的實體設定檔 (osk.ini)
                await invoke('reset_config');
                // 2. 清除瀏覽器快取 (localStorage 可能存有舊的視窗狀態)
                localStorage.clear();
                // 3. 設定標記，確保重啟後恢復 1.0 比例
                sessionStorage.setItem('reset_pending', 'true');
                // 4. 重啟以套用全新狀態
                location.reload();
            } catch (e) {
                console.error("Reset failed", e);
            }
        }
    });

    btnDynamic?.addEventListener('click', async () => {
        isDynamic = !isDynamic;
        syncUIState();
        updateKeyboardDynamicMod();
        await saveCurrentConfig();
    });

    btnPin?.addEventListener('click', async () => {
        isPinned = !isPinned;
        await invoke('set_pinned', { pinned: isPinned });
        btnPin.classList.remove('active-tool');
        btnPin.innerHTML = isPinned ? '📍' : '📌';
        await saveCurrentConfig();
    });

    btnSos?.addEventListener('click', async () => { 
        // 進入 SOS 模式前，先清除所有當前 toggled 的修飾鍵，避免干擾系統鍵盤
        for (const mod of toggledModifiers) {
            const modBtn = document.querySelector(`.key[data-code="${mod}"]`);
            if (modBtn) modBtn.classList.remove('active-toggle');
        }
        toggledModifiers.length = 0;
        await invoke('release_all_modifiers');
        invoke('open_sos'); 
    });

    btnEdit?.addEventListener('click', async () => {
        const entering = !isEditMode;
        isEditMode = entering;
        
        // 編輯模式暫存圖釘狀態
        if (entering) {
            pinnedBackupBeforeEdit = isPinned;
            if (!isPinned) {
                isPinned = true;
                await invoke('set_pinned', { pinned: true });
            }
        } else {
            if (pinnedBackupBeforeEdit !== null) {
                isPinned = pinnedBackupBeforeEdit;
                await invoke('set_pinned', { pinned: isPinned });
                pinnedBackupBeforeEdit = null;
            }
        }
        
        // 統一邏輯：切換模式時重置尺寸鎖定，並以按鍵內容尺寸為基準強制擴展視窗
        userAdjustedSize = false;
        skipNextSyncWindowSize = false; 
        
        syncUIState();
        renderKeys();
        
        // 執行多步同步，確保視窗尺寸完美貼合新的按鍵內容
        [100, 300, 600].forEach(delay => setTimeout(() => syncWindowSize(true), delay));
    });

    // IMPROVED DRAGGING logic
    const toolbar = document.getElementById('toolbar');
    toolbar?.addEventListener('mousedown', async (e) => {
        // Don't drag if clicking buttons or sliders
        const target = e.target as HTMLElement;
        if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.closest('button')) return;
        
        await invoke('start_custom_drag');
        // 移除這裡的 setTimeout，改用全域監聽 move 事件
    });
    
    
    btnTheme?.addEventListener('click', async () => {
        isDark = !isDark;
        applyTheme(isDark);
        syncUIState();
        await saveCurrentConfig();
    });

    opacitySlider?.addEventListener('input', async () => {
        if (keyboardNode) keyboardNode.style.opacity = opacitySlider.value;
        await saveCurrentConfig();
    });

    btnClose?.addEventListener('click', () => { invoke('force_exit'); });
    
    // Key Editor Listeners
    document.getElementById('btn-save-key')?.addEventListener('click', saveKeyLabels);
    document.getElementById('btn-cancel-key')?.addEventListener('click', closeKeyEditor);

    syncUIState(); // 初始化圖示狀態
}

function applyTheme(dark: boolean) {
    const root = document.documentElement;
    if (dark) {
        root.style.setProperty('--bg-color', 'rgb(15, 23, 42)');
        root.style.setProperty('--key-bg', 'rgba(255, 255, 255, 0.08)');
        root.style.setProperty('--text-main', '#f8fafc');
        root.style.setProperty('--text-sub', '#94a3b8');
        root.style.setProperty('--border-color', 'rgba(255, 255, 255, 0.1)');
        
        // 恢復深色模式原始高對比色彩
        root.style.setProperty('--color-tl', '#f8fafc'); 
        root.style.setProperty('--color-tr', '#38bdf8'); 
        root.style.setProperty('--color-bl', '#4ade80'); 
        root.style.setProperty('--color-br', '#fbbf24'); 
        
        root.style.setProperty('--corner-opacity', '0.8');
        root.style.setProperty('--corner-weight', '600');
    } else {
        root.style.setProperty('--bg-color', 'rgb(240, 240, 240)');
        root.style.setProperty('--key-bg', 'rgba(255, 255, 255, 0.6)');
        root.style.setProperty('--text-main', '#1e293b');
        root.style.setProperty('--text-sub', '#475569'); 
        root.style.setProperty('--border-color', 'rgba(0, 0, 0, 0.1)');
        
        // 淺色模式高對比角落色彩
        root.style.setProperty('--color-tl', '#1e293b'); 
        root.style.setProperty('--color-tr', '#0369a1'); 
        root.style.setProperty('--color-bl', '#15803d'); 
        root.style.setProperty('--color-br', '#b45309'); 
        
        // 淺色模式專屬：靜態標籤增強
        root.style.setProperty('--corner-opacity', '1.0');
        root.style.setProperty('--corner-weight', '700');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initApp();

    // 監聽來自 Rust 的外部狀態改變要求 (例如系統列選單操作)
    listen('backend_pin_updated', async (e: any) => {
        isPinned = e.payload === true;
        syncUIState();
        await saveCurrentConfig();
    });

    // 監聽實體鍵盤的按鍵回饋
    listen('physical_key', (e: any) => {
        const { code, is_down } = e.payload;
        // 使用 dataset.vk 去對應鍵盤上的按鍵，164與165為左右Alt，160與161為左右Shift等
        document.querySelectorAll(`.key[data-vk="${code}"]`).forEach((el: Element) => {
            const btn = el as HTMLElement;
            if (is_down) {
                btn.classList.add('physical-active');
            } else {
                btn.classList.remove('physical-active');
            }
        });
    });

    listen('focus_changed', (e: any) => {
        try {
            const data = JSON.parse(e.payload);
            const infoFocus = document.getElementById('info-focus');
            const infoClip = document.getElementById('info-clipboard');
            const imeStr = data.is_zh ? '中文' : '英文';
            
            if (infoFocus) {
                infoFocus.textContent = `${data.app} (${imeStr})`;
            }
            if (infoClip) {
                let clipText = data.clipboard || '';
                clipText = clipText.replace(/[\n\r]/g, ' ').trim();
                if (clipText.length > 30) {
                    clipText = clipText.substring(0, 30) + '...';
                }
                infoClip.textContent = clipText ? `📋 ${clipText}` : '📋 無內容';
            }

            const toolbarLeft = document.querySelector('.toolbar-left') as HTMLElement;
            if (toolbarLeft) {
                toolbarLeft.setAttribute('data-tip', `焦點: ${data.app}\n輸入法: ${imeStr}\n剪貼簿: ${data.clipboard || '無'}`);
            }

            // 語系同步：無條件同步 isZhuyinMode 以驅動靜態/動態標籤高亮
            if (data.is_zh !== isZhuyinMode) {
                isZhuyinMode = data.is_zh;
                updateKeyboardDynamicMod(); // 同步容器 class (mod-zh) 以驅動角落高亮
                
                // 僅在開啟「動態顯示」時才更換按鍵板面 (En 變 ㄅ)
                if (isDynamic) {
                    renderKeys();
                }
            }
        } catch (err) {
            // 回退舊版字串處理 (若有意外)
            const toolbarLeft = document.querySelector('.toolbar-left');
            if (toolbarLeft) {
                toolbarLeft.textContent = `${e.payload}`;
            }
        }
    });

  // 監聽視窗移動事件，實作防抖動自動存檔
  let moveTimeout: any = null;
  getCurrentWindow().listen('tauri://move', () => {
      if (moveTimeout) clearTimeout(moveTimeout);
      moveTimeout = setTimeout(() => {
          saveCurrentConfig();
      }, 500); // 停止移動 0.5 秒後存檔
  });

  // 監聽視窗縮放事件（加入程式化調整保護）
  window.addEventListener('resize', () => {
      if (isProgrammaticResize) return;
      
      userAdjustedSize = true;
      updateAppScale();
      if (moveTimeout) clearTimeout(moveTimeout);
      moveTimeout = setTimeout(() => {
          saveCurrentConfig();
      }, 500);
  });
});

window.addEventListener('dragstart', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('contextmenu', e => e.preventDefault());

/**
 * 實作自定義 Tooltip 邏輯，避免 HWND_TOPMOST 視窗蓋住系統原生 Tooltip
 */
function setupTooltips() {
    const tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) return;

    // 清理所有原生 title 以防在 HWND_TOPMOST 視窗閃現系統提示
    const allWithTitle = document.querySelectorAll('[title]');
    allWithTitle.forEach(el => {
        const t = el.getAttribute('title');
        if (t) {
            el.setAttribute('data-tip', t);
            el.removeAttribute('title');
        }
    });

    // 預先備份現有的 data-tip 作為基礎描述
    const allTips = document.querySelectorAll('[data-tip]');
    allTips.forEach(el => {
        if (!el.hasAttribute('data-tip-base')) {
            el.setAttribute('data-tip-base', el.getAttribute('data-tip') || "");
        }
    });

    const targets = document.querySelectorAll('[data-tip]');
    targets.forEach(target => {
        target.addEventListener('mouseenter', () => {
            currentHoverTarget = target as HTMLElement;
            refreshActiveTooltip();
            
            const tooltip = document.getElementById('custom-tooltip');
            if (tooltip) {
                tooltip.classList.add('visible');
                // 計算精確位置
                const rect = currentHoverTarget.getBoundingClientRect();
                tooltip.style.left = `${rect.left + rect.width / 2}px`;
                tooltip.style.top = `${rect.bottom + 8}px`;
                tooltip.style.transform = `translateX(-50%) translateY(0)`;
            }
        });

        target.addEventListener('mouseleave', () => {
            if (currentHoverTarget === target) {
                currentHoverTarget = null;
            }
            tooltip.classList.remove('visible');
        });
    });
}

/**
 * 當資料更新時，立刻重新渲染畫面上正在顯示的 Tooltip
 */
function refreshActiveTooltip() {
    const tooltip = document.getElementById('custom-tooltip');
    if (tooltip && currentHoverTarget) {
        const tip = currentHoverTarget.getAttribute('data-tip');
        if (tip) {
            tooltip.textContent = tip;
        } else {
            tooltip.classList.remove('visible');
        }
    }
}
