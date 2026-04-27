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

/**
 * Application State Definitions
 */
let currentHoverTarget: HTMLElement | null = null;
// When true, skip the next automatic syncWindowSize() call
// (e.g. restoring window to default size right after exiting edit mode)
let skipNextSyncWindowSize = false;
let userAdjustedSize = false;
let isProgrammaticResize = false;
let pinnedBackupBeforeEdit: boolean | null = null;
let keyRects: { key: KeyDefinition, x: number, y: number, w: number, h: number, row: number, col: number }[] = [];
let pressedKey: { key: KeyDefinition, rect: any } | null = null;
let hoverKey: KeyDefinition | null = null;
const physicalPressedCodes = new Set<number>();



// Custom Key Overrides & Long Press
let longPressTimer: any = null;
let editingKeyPos: string | null = null;
let dragStartX = 0;
let dragStartY = 0;
let dragSourcePos: { row: number, col: number } | null = null;
let dragTargetPos: { row: number, col: number } | null = null;
let dragCurrentX = 0;
let dragCurrentY = 0;
let isDraggingKey = false;
const LONG_PRESS_DURATION = 800;


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
                // Position data is handled in the sync section below
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

    // 3. Apply appearance and theme
    applyTheme(isDark);
    syncUIState();
    updateKeyboardDynamicMod();

    // 4. Sync metadata and backend state
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

    // Window positioning and sizing
    setTimeout(async () => {
        const isReset = isFirstBoot;
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
        await syncWindowSize(isReset);
    }, 100);
    
    // Listen for physical keyboard events
    listen('physical_key', (event: any) => {
        const { code, is_down } = event.payload;
        if (is_down) {
            physicalPressedCodes.add(code);
        } else {
            physicalPressedCodes.delete(code);
        }
        renderKeys();
    });
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



function getCanvasColors() {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
        bg: rootStyle.getPropertyValue('--bg-color').trim(),
        keyBg: rootStyle.getPropertyValue('--key-bg').trim(),
        keyActive: rootStyle.getPropertyValue('--key-active').trim(),
        keyToggle: rootStyle.getPropertyValue('--key-toggle').trim(),
        textMain: rootStyle.getPropertyValue('--text-main').trim(),
        textSub: rootStyle.getPropertyValue('--text-sub').trim(),
        border: rootStyle.getPropertyValue('--border-color').trim(),
        accent: rootStyle.getPropertyValue('--accent').trim(),
        colorTl: rootStyle.getPropertyValue('--color-tl').trim(),
        colorTr: rootStyle.getPropertyValue('--color-tr').trim(),
        colorBl: rootStyle.getPropertyValue('--color-bl').trim(),
        colorBr: rootStyle.getPropertyValue('--color-br').trim(),
        colorNum: rootStyle.getPropertyValue('--color-num').trim(),
        keySpecialBg: rootStyle.getPropertyValue('--key-special-bg').trim(),
        cornerOpacity: parseFloat(rootStyle.getPropertyValue('--corner-opacity') || "0.8"),
    };
}

function renderKeys() {
    const canvas = document.getElementById('keyboard-canvas') as HTMLCanvasElement;
    if (!canvas || !currentLayout.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const colors = getCanvasColors();
    const dpr = window.devicePixelRatio || 1;
    
    const rowHeight = 48;
    const gap = 5;

    // 1. 第一輪：計算實際需要的總寬度
    let maxLayoutWidth = 0;
    currentLayout.forEach((rowData) => {
        let currentWUnit = 0;
        rowData.forEach((key) => {
            const wUnit = key.width || 1;
            let x: number, w: number;
            
            if (isFull) {
                const gridSpan = Math.round(wUnit * 12);
                x = (currentWUnit / 270) * 1060;
                w = (gridSpan / 270) * 1060;
                currentWUnit += gridSpan;
            } else {
                x = Math.round(currentWUnit * 47);
                w = Math.round((currentWUnit + wUnit) * 47) - x - 5;
                currentWUnit += wUnit;
            }
            if (x + w > maxLayoutWidth) maxLayoutWidth = x + w;
        });
    });

    const baseWidth = maxLayoutWidth + 8; // 包含 4px * 2 的左右 Padding
    document.documentElement.style.setProperty('--base-width', `${baseWidth}px`);
    
    // 計算總高度：按鍵區域 + 工具列 (約 41px) + 上下 Padding (8px)
    const keysHeight = currentLayout.length * (rowHeight + gap) - gap;
    const baseHeight = keysHeight + 41 + 8; 
    document.documentElement.style.setProperty('--base-height', `${baseHeight}px`);
    
    let totalHeight = keysHeight;
    
    // 2. 設置 Canvas 物理像素大小
    canvas.width = baseWidth * dpr;
    canvas.height = (totalHeight + 2) * dpr;
    canvas.style.width = `${baseWidth}px`;
    canvas.style.height = `${totalHeight + 2}px`;
    ctx.scale(dpr, dpr);
    
    keyRects = [];
    ctx.clearRect(0, 0, baseWidth, totalHeight + 2);

    const isShift = toggledModifiers.includes(0xA0) || toggledModifiers.includes(0xA1);
    const isFn = toggledModifiers.includes(0xFE);
    const isCaps = toggledModifiers.includes(0x14);
    const isNum = toggledModifiers.includes(0x90);

    // 3. 第二輪：繪製
    currentLayout.forEach((rowData, rowIndex) => {
        let currentWUnit = 0;
        const y = rowIndex * (rowHeight + gap);

        rowData.forEach((key, colIndex) => {
            const wUnit = key.width || 1;
            let x: number, w: number;
            
            if (isFull) {
                const gridSpan = Math.round(wUnit * 12);
                x = (currentWUnit / 270) * 1060;
                w = (gridSpan / 270) * 1060;
                currentWUnit += gridSpan;
            } else {
                x = Math.round(currentWUnit * 47);
                w = Math.round((currentWUnit + wUnit) * 47) - x - 5;
                currentWUnit += wUnit;
            }
            
            const h = (key.height === 2) ? (rowHeight * 2 + gap) : rowHeight;

            const rect = { x, y, w, h };
            keyRects.push({ key, ...rect, row: rowIndex, col: colIndex });

            // 繪製按鍵背景
            drawKey(ctx, key, rect, colors, isShift, isFn, isCaps, isNum);
        });
    });

    if (!isProgrammaticResize) {
        syncWindowSize();
    }

    // 4. 繪製拖曳中的「幽靈按鍵」
    if (isDraggingKey && dragSourcePos) {
        const sourceKey = currentLayout[dragSourcePos.row][dragSourcePos.col];
        const rect = canvas.getBoundingClientRect();
        const appScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
        
        // 計算拖曳按鍵的中心位置與原始寬高
        const sourceRect = keyRects.find(r => r.row === dragSourcePos?.row && r.col === dragSourcePos?.col);
        if (sourceRect) {
            const gx = (dragCurrentX - rect.left) / appScale - sourceRect.w / 2;
            const gy = (dragCurrentY - rect.top) / appScale - sourceRect.h / 2;
            
            ctx.save();
            ctx.globalAlpha = 0.6;
            ctx.translate(gx, gy);
            drawKey(ctx, sourceKey, { x: 0, y: 0, w: sourceRect.w, h: sourceRect.h }, colors, isShift, isFn, isCaps, isNum);
            ctx.restore();
        }
    }
}

function drawKey(ctx: CanvasRenderingContext2D, key: KeyDefinition, rect: any, colors: any, isShift: boolean, isFn: boolean, isCaps: boolean, isNum: boolean) {
    if (key.class?.includes('invisible')) return;

    const isActive = pressedKey?.key === key || physicalPressedCodes.has(key.code);
    const isToggled = toggledModifiers.includes(key.code);
    const isHover = hoverKey === key;

    // --- 背景與陰影 ---
    ctx.save();
    
    // 如果是正在被拖曳的原始位置，則淡出
    if (isDraggingKey && dragSourcePos) {
        const sourceKey = currentLayout[dragSourcePos.row][dragSourcePos.col];
        if (key === sourceKey) {
            ctx.globalAlpha = 0.2;
        }
    }

    ctx.beginPath();
    const radius = 10;
    // @ts-ignore
    if (ctx.roundRect) {
        // @ts-ignore
        ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
    } else {
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
    }
    
    // 定義特殊按鍵判斷 (包含屬性、類別、或是空白鍵)
    const isKeySpecial = key.special || key.class?.includes('special') || key.class?.includes('space');

    // 判斷是否為當前拖曳的目標
    let isDragTarget = false;
    if (isDraggingKey && dragTargetPos) {
        const targetKey = currentLayout[dragTargetPos.row][dragTargetPos.col];
        if (key === targetKey) {
            isDragTarget = true;
        }
    }

    if (isActive) {
        ctx.fillStyle = colors.keyActive;
    } else if (isToggled) {
        ctx.fillStyle = colors.keyToggle;
    } else if (isHover || isDragTarget) {
        ctx.fillStyle = isDragTarget ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.15)';
    } else {
        ctx.fillStyle = isKeySpecial ? colors.keySpecialBg : colors.keyBg;
    }
    
    ctx.fill();
    
    // 邊框樣式
    ctx.strokeStyle = (isToggled || (isEditMode && isHover) || isDragTarget) ? colors.accent : colors.border;
    ctx.lineWidth = 1;
    if (isDragTarget) {
        ctx.lineWidth = 3;
        ctx.setLineDash([]); // 實線高亮
    } else if (isEditMode && isHover) {
        ctx.setLineDash([5, 3]);
        ctx.lineWidth = 2;
    }
    
    ctx.stroke();
    ctx.setLineDash([]); // 重置虛線
    ctx.restore();

    // --- 標籤繪製 ---
    const isAlpha = key.label.length === 1 && /^[a-zA-Z]$/.test(key.label);
    const centerChar = getCenterLabel(key, isShift, isFn, isCaps, isNum);
    const centerColor = getLabelColor(key, centerChar, colors, isShift, isFn, isCaps, isNum);

    if (isDynamic) {
        // 動態模式：只繪製中央標籤
        drawText(ctx, centerChar, rect.x + rect.w/2, rect.y + rect.h/2, centerColor, 24, "center", 1, rect.w - 10);
    } else {
        // 靜態模式：繪製四角標籤
        const isArrowOrBS = [0x08, 0x25, 0x26, 0x27, 0x28].includes(key.code);

        if (key.class?.includes('num-key')) {
             const navStr = key.sub || key.label;
             const numStr = key.label;
             // NumLock 狀態切換亮度
             drawText(ctx, navStr, rect.x + 6, rect.y + 16, colors.textMain, 13, "left", isNum ? 0.3 : 1);
             drawText(ctx, numStr, rect.x + rect.w - 6, rect.y + rect.h - 6, colors.colorNum, 10, "right", isNum ? 1 : 0.3);
        } else if (!isKeySpecial || isArrowOrBS) {
            // 一般按鍵 或 方向鍵/倒退鍵：繪製四角
            // 對於方向鍵/倒退鍵，我們不繪製 TL，因為它會顯示在中央
            const tlDisp = isArrowOrBS ? null : (key.tl_ov?.display || key.label);
            const trDisp = key.tr_ov?.display || key.sub;
            const blDisp = key.bl_ov?.display || key.fn;
            const brDisp = key.br_ov?.display || key.zhPinyin;

            // 判斷當前模式下的高亮
            let highlight = "tl";
            if (isFn && key.fn) highlight = "bl";
            else if (isShift) highlight = "tr";
            else if (isZhuyinMode && key.zhPinyin) highlight = "br";
            else if (isCaps && isAlpha) highlight = "tr";

            if (tlDisp) drawText(ctx, tlDisp, rect.x + 6, rect.y + 16, colors.colorTl, 13, "left", highlight === "tl" ? 1 : 0.3);
            if (trDisp) drawText(ctx, trDisp, rect.x + rect.w - 6, rect.y + 16, colors.colorTr, 10, "right", highlight === "tr" ? 1 : 0.3);
            if (blDisp) drawText(ctx, blDisp, rect.x + 6, rect.y + rect.h - 6, colors.colorBl, 10, "left", highlight === "bl" ? 1 : 0.3);
            if (brDisp) drawText(ctx, brDisp, rect.x + rect.w - 6, rect.y + rect.h - 6, colors.colorBr, 10, "right", highlight === "br" ? 1 : 0.3);
        }
        
        // 特殊按鍵 (包含方向鍵/倒退鍵) 在靜態模式也要顯示中央標籤
        if (isKeySpecial) {
            // 對於方向鍵/倒退鍵，中央標籤始終顯示原始標籤 (白色)
            const label = isArrowOrBS ? key.label : centerChar;
            const color = isArrowOrBS ? colors.textMain : centerColor;
            drawText(ctx, label, rect.x + rect.w/2, rect.y + rect.h/2, color, 24, "center", 1, rect.w - 10);
        }
    }
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, align: "left"|"right"|"center", opacity: number = 1, maxW?: number) {
    if (!text) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    
    let fontSize = size;
    ctx.font = `bold ${fontSize}px Inter, sans-serif`;
    
    // 如果有指定最大寬度，則進行自動縮放
    if (maxW) {
        let metrics = ctx.measureText(text);
        while (metrics.width > maxW && fontSize > 8) {
            fontSize -= 1;
            ctx.font = `bold ${fontSize}px Inter, sans-serif`;
            metrics = ctx.measureText(text);
        }
    }
    
    ctx.fillText(text, x, y);
    ctx.restore();
}

function getCenterLabel(key: KeyDefinition, isShift: boolean, isFn: boolean, isCaps: boolean, isNum: boolean): string {
    const isAlpha = key.label.length === 1 && /^[a-zA-Z]$/.test(key.label);
    
    if (key.code === 0x5D) return isZhuyinMode ? 'En' : 'ㄅ';
    if (isFn && key.fn) return key.fn;
    if (isShift) return key.sub || (isAlpha ? key.label.toUpperCase() : key.label);
    if (isZhuyinMode && key.zhPinyin) return key.zhPinyin;
    if (isCaps && isAlpha) return key.label.toUpperCase();
    if (key.class?.includes('num-key')) return isNum ? key.label : (key.sub || key.label);
    
    return key.special ? key.label : key.label.toLowerCase();
}

function getLabelColor(key: KeyDefinition, _char: string, colors: any, isShift: boolean, isFn: boolean, _isCaps: boolean, isNum: boolean): string {
    // 1. 特殊功能鍵本體顏色 (對應其功能的角落顏色)
    if (key.code === 0x5D && !isZhuyinMode) return colors.colorBr; // ㄅ 模式
    if (key.code === 0xFE) return colors.colorBl; // Fn 鍵
    if (key.code === 0xA0 || key.code === 0xA1) return colors.colorTr; // Shift 鍵
    if (key.code === 0x14) return colors.colorTr; // Caps 鍵
    if (key.code === 0x90) return colors.colorNum; // NumLock 鍵

    // 2. 一般按鍵根據當前切換模式顯示的高亮色
    if (isFn && key.fn) return colors.colorBl;
    if (isShift) {
        const isAlpha = key.label.length === 1 && /^[a-zA-Z]$/.test(key.label);
        if (isAlpha || key.sub) return colors.colorTr;
    }
    if (isZhuyinMode && key.zhPinyin) return colors.colorBr;
    if (_isCaps) {
        const isAlpha = key.label.length === 1 && /^[a-zA-Z]$/.test(key.label);
        if (isAlpha) return colors.colorTr;
    }
    if (key.class?.includes('num-key') && isNum) return colors.colorNum;
    
    // 3. 預設顏色
    if (key.class?.includes('cyan-text')) return colors.accent;
    return colors.textMain;
}

function initCanvasEvents() {
    const canvas = document.getElementById('keyboard-canvas') as HTMLCanvasElement;
    if (!canvas) return;

    canvas.addEventListener('pointerdown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const appScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
        const x = (e.clientX - rect.left) / appScale;
        const y = (e.clientY - rect.top) / appScale;

        const hit = keyRects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
        if (hit) {
            if (!isEditMode) {
                pressedKey = { key: hit.key, rect: hit };
                handleKeyPressDirect(hit.key);
                renderKeys();
            } else {
                handleEditDragStart(e, hit);
            }
        }
    });

    canvas.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const appScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
        const x = (e.clientX - rect.left) / appScale;
        const y = (e.clientY - rect.top) / appScale;
        
        if (longPressTimer) {
            const dx = Math.abs(e.clientX - dragStartX);
            const dy = Math.abs(e.clientY - dragStartY);
            if (dx > 8 || dy > 8) { 
                clearTimeout(longPressTimer);
                longPressTimer = null;
                
                if (isEditMode && dragSourcePos) {
                    isDraggingKey = true;
                }
            }
        }

        if (isDraggingKey) {
            dragCurrentX = e.clientX;
            dragCurrentY = e.clientY;
            
            const hit = keyRects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
            if (hit) {
                dragTargetPos = { row: hit.row, col: hit.col };
            } else {
                dragTargetPos = null;
            }
            
            renderKeys();
            return;
        }

        const hit = keyRects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
        if (hit?.key !== hoverKey) {
            hoverKey = hit?.key || null;
            renderKeys();
        }
    });

    window.addEventListener('pointerup', async (e) => {
        if (isDraggingKey && dragSourcePos) {
            const rect = canvas.getBoundingClientRect();
            const appScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
            const x = (e.clientX - rect.left) / appScale;
            const y = (e.clientY - rect.top) / appScale;
            
            const target = keyRects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
            if (target && (target.row !== dragSourcePos.row || target.col !== dragSourcePos.col)) {
                const sourceSlot = currentLayout[dragSourcePos.row][dragSourcePos.col];
                const targetSlot = currentLayout[target.row][target.col];
                
                // 備份原始形狀屬性
                const sW = sourceSlot.width;
                const sH = sourceSlot.height;
                const tW = targetSlot.width;
                const tH = targetSlot.height;
                
                // 交換內容
                const tempSource = { ...sourceSlot };
                currentLayout[dragSourcePos.row][dragSourcePos.col] = { ...targetSlot };
                currentLayout[target.row][target.col] = tempSource;
                
                // 還原形狀屬性到所在位置
                currentLayout[dragSourcePos.row][dragSourcePos.col].width = sW;
                currentLayout[dragSourcePos.row][dragSourcePos.col].height = sH;
                currentLayout[target.row][target.col].width = tW;
                currentLayout[target.row][target.col].height = tH;
                
                await saveCurrentConfig();
            }
        }

        if (pressedKey) {
            handleKeyReleaseDirect(pressedKey.key);
            pressedKey = null;
        }

        dragSourcePos = null;
        dragTargetPos = null;
        isDraggingKey = false;
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        renderKeys();
    });
}

function handleKeyPressDirect(key: KeyDefinition) {
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
            invoke('simulate_combination', { vkCodes: vks });
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
        if (key.code !== 0xFE) {
            if (key.code === 0xA4 || key.code === 0xA5) {
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: false });
                invoke('simulate_key', { vkCode: 0xFF, isKeyUp: true });
            }
            invoke('simulate_key', { vkCode: key.code, isKeyUp: true });
        }
      } else { 
        toggledModifiers.push(key.code);
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

async function handleKeyReleaseDirect(key: KeyDefinition) {
    const isModifier = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0xFE].includes(key.code);
    if (!isModifier) {
      if (key.code === 0x5D) return; 

      const isShift = toggledModifiers.includes(0xA0) || toggledModifiers.includes(0xA1);
      const isFn = toggledModifiers.includes(0xFE);
      let override: CornerOverride | undefined;
      if (isFn && key.bl_ov?.value) override = key.bl_ov;
      else if (isShift && key.tr_ov?.value) override = key.tr_ov;
      else if (isZhuyinMode && key.br_ov?.value) override = key.br_ov;
      else if (key.tl_ov?.value) override = key.tl_ov;

      if (override) {
          const vks = parseKeyValue(override.value);
          if (vks.length === 1) {
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
      if (key.code === 0x90 || key.code === 0x14) await checkAndSyncLocks();
      
      const isAltTab = key.code === 0x09 && (toggledModifiers.includes(0xA4) || toggledModifiers.includes(0xA5));
      for (const mod of toggledModifiers) {
         if (mod !== 0xFE && mod !== 0x14 && mod !== 0x90) {
            if (isAltTab && (mod === 0xA4 || mod === 0xA5)) continue;
            invoke('simulate_key', { vkCode: mod, isKeyUp: true });
         }
      }
      if (!isAltTab) invoke('release_all_modifiers');
      for (let i = toggledModifiers.length - 1; i >= 0; i--) {
          const modInfo = toggledModifiers[i];
          if (modInfo !== 0x14 && modInfo !== 0x90 && modInfo !== 0xFE) {
              if (isAltTab && (modInfo === 0xA4 || modInfo === 0xA5)) continue;
              toggledModifiers.splice(i, 1);
          }
      }
      updateKeyboardDynamicMod();
    }
}

function handleEditDragStart(e: PointerEvent, hit: any) {
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragSourcePos = { row: hit.row, col: hit.col };
    isDraggingKey = false;
    
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        editingKeyPos = `${hit.row},${hit.col}`;
        openKeyEditor(hit.key);
    }, LONG_PRESS_DURATION);
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
    
    // 基準寬度 (由 renderKeys 動態計算並存在 CSS 變數中)
    const baseWidthStr = getComputedStyle(document.documentElement).getPropertyValue('--base-width');
    const baseWidth = parseFloat(baseWidthStr) || (isFull ? 1078 : 723);
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
        
        // 使用佈局基準高度 (由 renderKeys 動態計算)
        const baseHeightStr = getComputedStyle(document.documentElement).getPropertyValue('--base-height');
        const naturalHeight = parseFloat(baseHeightStr) || kb.scrollHeight;
        
        // 使用佈局基準寬度 (由 renderKeys 動態計算)
        const baseWidthStr = getComputedStyle(document.documentElement).getPropertyValue('--base-width');
        const naturalWidth = parseFloat(baseWidthStr) || (isFull ? 1078 : 723);
        
        // 計算實際視窗尺寸，採比例維持型同步，確保切換版面後按鍵視覺尺寸一致
        const width = Math.ceil(naturalWidth * currentScale); 
        const height = Math.ceil(naturalHeight * currentScale); 
        
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
    toolbar?.addEventListener('pointerdown', async (evt) => {
        const e = evt as PointerEvent;
        const target = e.target as HTMLElement;
        // 允許滑鼠左鍵 / 觸控 / 手寫筆按下即可觸發拖移，但避免在按鈕或輸入元件上啟動
        const isPointerAllowed = (e.button === 0) || e.pointerType === 'touch' || e.pointerType === 'pen';
        if (!isPointerAllowed || target.closest('button') || target.closest('input')) return;

        // 直接呼叫後端強化的拖曳邏輯 (已針對 Windows 觸控優化)
        invoke('start_custom_drag');
    });
    
    
    btnTheme?.addEventListener('click', async () => {
        isDark = !isDark;
        applyTheme(isDark);
        syncUIState();
        renderKeys();
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
        root.style.setProperty('--key-special-bg', 'rgba(255, 255, 255, 0.04)');
        root.style.setProperty('--key-active', 'rgba(56, 189, 248, 0.4)');
        root.style.setProperty('--key-toggle', 'rgba(56, 189, 248, 0.2)');
        root.style.setProperty('--text-main', '#f8fafc');
        root.style.setProperty('--text-sub', '#94a3b8');
        root.style.setProperty('--border-color', 'rgba(255, 255, 255, 0.1)');
        root.style.setProperty('--accent', '#38bdf8');
        
        root.style.setProperty('--color-tl', '#f8fafc'); 
        root.style.setProperty('--color-tr', '#38bdf8'); 
        root.style.setProperty('--color-bl', '#4ade80'); 
        root.style.setProperty('--color-br', '#fbbf24'); 
        root.style.setProperty('--color-num', '#bae6fd');
        
        root.style.setProperty('--corner-opacity', '0.8');
        root.style.setProperty('--corner-weight', '600');
    } else {
        root.style.setProperty('--bg-color', '#f1f5f9');
        root.style.setProperty('--key-bg', '#ffffff');
        root.style.setProperty('--key-special-bg', '#e2e8f0');
        root.style.setProperty('--key-active', 'rgba(2, 132, 199, 0.3)');
        root.style.setProperty('--key-toggle', 'rgba(2, 132, 199, 0.15)');
        root.style.setProperty('--text-main', '#0f172a');
        root.style.setProperty('--text-sub', '#475569'); 
        root.style.setProperty('--border-color', 'rgba(0, 0, 0, 0.08)');
        root.style.setProperty('--accent', '#0284c7');
        
        root.style.setProperty('--color-tl', '#0f172a'); 
        root.style.setProperty('--color-tr', '#0369a1'); 
        root.style.setProperty('--color-bl', '#15803d'); 
        root.style.setProperty('--color-br', '#b45309'); 
        root.style.setProperty('--color-num', '#0369a1');
        
        root.style.setProperty('--corner-opacity', '1.0');
        root.style.setProperty('--corner-weight', '700');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initApp();
    initCanvasEvents();

    // 監聽來自 Rust 的外部狀態改變要求 (例如系統列選單操作)
    listen('backend_pin_updated', async (e: any) => {
        isPinned = e.payload === true;
        syncUIState();
        await saveCurrentConfig();
    });

    // 監聽實體鍵盤的按鍵回饋
    listen('physical_key', (_e: any) => {
        // 在 Canvas 模式下，我們需要根據 code 尋找對應的按鍵並重繪
        // 為了簡單起見，直接全域重繪
        renderKeys();
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
        } catch (err) { }
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
      renderKeys(); // 視窗縮放時重繪 Canvas
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
