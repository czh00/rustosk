import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { compactLayout, fullLayout, KeyDefinition } from './layouts';

declare const __APP_VERSION__: string;
// const APP_VERSION = __APP_VERSION__;

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
        await invoke('set_pinned', { pinned: isPinned });
        await invoke('set_dynamic_display', { enabled: isDynamic });
        await checkAndSyncLocks();
    } catch (e) { console.error(e); }

    // 5. 視窗定位與尺寸同步
    setTimeout(async () => {
        const savedData = await invoke<string>('load_config').catch(() => "{}");
        const config = JSON.parse(savedData);
        if (config.w && config.h) {
            await invoke('resize_window', { width: config.w, height: config.h });
        }
        if (config.rX !== undefined && config.rY !== undefined && !isFirstBoot) {
             await invoke('apply_relative_pos', { rx: config.rX, ry: config.rY });
        }
        await syncWindowSize();
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
          const gridSpan = Math.round(w * 4);
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

      // 功能鍵模式切換提示邏輯 (v1.0.8)
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
          // Numpad inversion (v1.1.5): Nav string (sub) at top-left, Number (label) at bottom-right
          const navStr = key.sub || key.label;
          const numStr = key.label;
          let tlNavStyle = `font-size: ${getAutoFontSize(navStr, 13)};`;
          if (navStr.length >= 3) tlNavStyle += ' left: 4px;';
          inner += `<span class="tl" style="${tlNavStyle}">${navStr}</span>`;
          inner += `<span class="br ${labelClass}" style="font-size: ${getAutoFontSize(numStr, 10)}">${numStr}</span>`;
      } else {
          inner = `<span class="tl ${labelClass}" style="${tlStyle}">${displayLabel}</span>`;
          if (key.sub) inner += `<span class="tr" style="font-size: ${getAutoFontSize(key.sub, 10)}">${key.sub}</span>`;
          if (key.fn) inner += `<span class="bl" style="font-size: ${getAutoFontSize(key.fn, 10)}">${key.fn}</span>`;
          if (key.zhPinyin) inner += `<span class="br" style="font-size: ${getAutoFontSize(key.zhPinyin, 10)}">${key.zhPinyin}</span>`;
      }
      
      // 中央動態標籤邏輯
      let centerChar = key.label;
      let centerClass = '';
      
      // 首先處理功能鍵本身的提示配色 (v1.1.0)
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
          centerChar = isZhuyinMode ? 'En' : 'ㄅ';
          centerClass = isZhuyinMode ? '' : 'color-zh';
      } else if (key.special && !isDynamic) {
          // 靜態模式下的功能鍵處理
          centerChar = displayLabel;
      }

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
        const rect = btn.getBoundingClientRect();
        dragStartX = e.clientX - rect.left;
        dragStartY = e.clientY - rect.top;
        draggedKey = btn;
        btn.classList.add('dragging');
        
        ghost = btn.cloneNode(true) as HTMLElement;
        ghost.classList.add('key-ghost');
        ghost.style.left = rect.left + 'px';
        ghost.style.top = rect.top + 'px';
        document.body.appendChild(ghost);
        btn.setPointerCapture(e.pointerId);
      });

      btn.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isEditMode || !draggedKey || !ghost) return;
        ghost.style.left = (e.clientX - dragStartX) + 'px';
        ghost.style.top = (e.clientY - dragStartY) + 'px';
        
        const target = getDropTarget(e.clientX, e.clientY);
        document.querySelectorAll('.key').forEach(k => k.classList.remove('drag-over'));
        if (target && target !== draggedKey) target.classList.add('drag-over');
      });

      btn.addEventListener('pointerup', (e: PointerEvent) => {
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

async function handleKeyPress(btn: HTMLElement, key: KeyDefinition) {
    btn.classList.add('active');
    const isModifier = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0xFE].includes(key.code);
    if (isModifier) {
      const idx = toggledModifiers.indexOf(key.code);
      if (idx > -1) { 
        toggledModifiers.splice(idx, 1);
        btn.classList.remove('active-toggle');
        if (key.code !== 0xFE) {
            if (key.code === 0xA4 || key.code === 0xA5) {
                // 遮蔽 Alt 釋放訊號，避免彈出應用程式選單 (VK_NONAME = 0xFF)
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
    // 模擬輸入法切換鍵 (0x5D)
    // 透過發送 Shift 訊號供系統切換，UI 狀態將由後端 focus_changed 事件統一驅動
    if (key.code === 0x5D) {
       invoke('simulate_key', { vkCode: 0xA0, isKeyUp: false });
       setTimeout(() => invoke('simulate_key', { vkCode: 0xA0, isKeyUp: true }), 50);
       return;
    }

    const isFn = toggledModifiers.includes(0xFE);
    let targetVk = key.code;

    if (isFn && key.fn) {
        if (key.fn.startsWith('F')) {
            const fNum = parseInt(key.fn.substring(1));
            targetVk = 0x6F + fNum; // F1=0x70, F12=0x7B
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
      if (key.code === 0x5D) return; // 屏蔽注音切換鍵的原生物理信號
      const isFn = toggledModifiers.includes(0xFE);
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
      
      // 如果按的是 NumLock (0x90) 或 CapsLock (0x14)，立刻同步 UI
      if (key.code === 0x90 || key.code === 0x14) {
          await checkAndSyncLocks();
      }
      
      // 智慧 Alt-Tab 邏輯 (v1.1.6)：若目前按的是 Tab (0x09)，且 Alt 已被切換常駐，就不主動釋放 Alt
      const isAltTab = key.code === 0x09 && (toggledModifiers.includes(0xA4) || toggledModifiers.includes(0xA5));

      for (const mod of toggledModifiers) {
         if (mod !== 0xFE && mod !== 0x14 && mod !== 0x90) {
            // 若為 Alt-Tab 連鎖技且目前釋放對象為 Alt，則略過 (保留 Alt 的物理按下狀態)
            if (isAltTab && (mod === 0xA4 || mod === 0xA5)) {
                continue;
            }
            if (mod === 0xA4 || mod === 0xA5) {
                // 自動釋放時同樣進行 Alt 遮蔽
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: false });
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: true });
            }
            invoke('simulate_key', { vkCode: mod, isKeyUp: true });
         }
      }
      
      // 若為 Alt-Tab 組合則略過全域釋放以維持連續切換狀態
      if (!isAltTab) {
          invoke('release_all_modifiers');
      }

      for (let i = toggledModifiers.length - 1; i >= 0; i--) {
          const modInfo = toggledModifiers[i];
          // 陣列中移除已釋放的修飾鍵。若是 Alt 且是 Alt-Tab 組合，就保留！
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
    const w1 = k1.width;
    const w2 = k2.width;
    const temp = { ...k1 };
    currentLayout[r1][c1] = { ...k2, width: w1 };
    currentLayout[r2][c2] = { ...temp, width: w2 };
    
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
    const kb = document.getElementById('keyboard');
    if (!kb) return;

    // 使用標準 Web API 的 window.innerWidth，這已是邏輯像素
    const logicalWidth = window.innerWidth;
    
    // 基準寬度
    const baseWidth = isFull ? 1078 : 723;
    const scale = logicalWidth / baseWidth;
    
    document.documentElement.style.setProperty('--app-scale', scale.toString());
}

async function syncWindowSize() {
    const kb = document.getElementById('keyboard');
    if (!kb) return;
    
    requestAnimationFrame(async () => {
        const rect = kb.getBoundingClientRect();
        const currentScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
        
        // 使用佈局基準寬度
        const targetBaseWidth = isFull ? 1078 : 723;
        const width = targetBaseWidth + 4;
        
        // 動態計算高度並還原比例
        const height = Math.round((rect.height / currentScale) + 6);

        await invoke('update_aspect_ratio', { width, height });
        await invoke('resize_and_recenter', { width, height, forceCenter: isFirstBoot });
        
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
        
        // 切換佈局前更新基準寬度與縮放鎖定
        const baseWidth = isFull ? 1078 : 723;
        document.documentElement.style.setProperty('--base-width', `${baseWidth}px`);
        
        await invoke('update_aspect_ratio', { width: baseWidth + 4, height: 320 });
        await invoke('resize_window', { width: baseWidth + 4, height: 320 });
        
        syncUIState(); 
        renderKeys();
        
        // 額外保險
        setTimeout(syncWindowSize, 200);
        setTimeout(saveCurrentConfig, 1000);
    });

    btnReset?.addEventListener('click', async () => {
        if (confirm("確定要將所有佈局、位置與透明度恢復為預設值嗎？")) {
            try {
                // 1. 清除 Rust 端的實體設定檔 (osk.ini)
                await invoke('reset_config');
                // 2. 清除瀏覽器快取
                localStorage.clear();
                // 3. 設定預設透明度為 1.0 (完全不透明)
                localStorage.setItem('osk_opacity', '1.0');
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

    btnEdit?.addEventListener('click', () => {
        isEditMode = !isEditMode;
        btnEdit.classList.toggle('active-tool', isEditMode);
        document.body.classList.toggle('edit-mode', isEditMode);
        renderKeys();
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

  // 監聽視窗縮放事件
  window.addEventListener('resize', () => {
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
 * 實作自定義 Tooltip 邏輯，避免 HWND_TOPMOST 視窗蓋住系統原生 Tooltip (v1.1.5)
 */
function setupTooltips() {
    const tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) return;

    // 清理所有原生 title 以防在 HWND_TOPMOST 視窗閃現系統提示 (v1.1.5)
    const allWithTitle = document.querySelectorAll('[title]');
    allWithTitle.forEach(el => {
        const t = el.getAttribute('title');
        if (t) {
            el.setAttribute('data-tip', t);
            el.removeAttribute('title');
        }
    });

    // 預先備份現有的 data-tip 作為基礎描述 (v1.1.6)
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
 * 當資料更新時，立刻重新渲染畫面上正在顯示的 Tooltip (v1.1.6)
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
