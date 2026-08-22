import { invoke } from '@tauri-apps/api/core';
import { open, ask, message } from '@tauri-apps/plugin-dialog';

import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { compactLayout, fullLayout, KeyDefinition, CornerOverride } from './layouts';

declare const __APP_VERSION__: string;

const toggledModifiers: number[] = [];
let currentLayout: KeyDefinition[][] = compactLayout;
let isFull = false;
let isDynamic = true;
let isPinned = true;
let isZhuyinMode = false;
let isDark = true;
let isAutoTheme = true;
let isEditMode = false;
let isFirstBoot = false;
let lastCapsStatus = false;
let lastNumStatus = false;

// 全域錄製狀態 (用於編輯器)
let recordingTargetId: string | null = null;
let lastRecordTime = 0;
let isMacroLooping = false;
let loopingKey: KeyDefinition | null = null;

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
let lastEditorData: any = null;
const batchOriginalStates = new Map<number, any>();
const LONG_PRESS_DURATION = 800;


interface OSKConfig {
    compactLayout: KeyDefinition[][];
    fullLayout: KeyDefinition[][];
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
    themeOverrides?: Record<string, string>;
    isAutoTheme?: boolean;
}

let userCompactLayout: KeyDefinition[][] = compactLayout;
let userFullLayout: KeyDefinition[][] = fullLayout;

async function initApp() {
    isFirstBoot = false;

    // 1. 初始化設定載入
    try {
        const isReset = sessionStorage.getItem('reset_pending') === 'true';
        if (isReset) {
            sessionStorage.removeItem('reset_pending');
            // 重置偵測：恢復預設 1.0 比例
            isFirstBoot = true;
            userAdjustedSize = false;
            document.documentElement.style.setProperty('--app-scale', '1');

        }

        const savedData = await invoke<string>('load_config');
        const config = JSON.parse(savedData);

        if (config && (config.compactLayout || config.fullLayout || config.isFull !== undefined)) {
            isFull = config.isFull || false;
            userCompactLayout = config.compactLayout || compactLayout;
            userFullLayout = config.fullLayout || fullLayout;
            currentLayout = isFull ? userFullLayout : userCompactLayout;

            isDynamic = config.isDynamic !== undefined ? Boolean(config.isDynamic) : true;
            isPinned = config.isPinned !== undefined ? Boolean(config.isPinned) : true;
            isZhuyinMode = config.isZhuyinMode !== undefined ? Boolean(config.isZhuyinMode) : false;
            isAutoTheme = config.isAutoTheme !== undefined ? Boolean(config.isAutoTheme) : true;
            
            if (isAutoTheme) {
                isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            } else {
                isDark = config.isDark !== undefined ? Boolean(config.isDark) : true;
            }

            if (config.rX !== undefined && config.rY !== undefined) {
                // Position data is handled in the sync section below
            } else {
                isFirstBoot = true;
            }

            if (config.opacity !== undefined) {
                const kb = document.getElementById('keyboard');
                if (kb) kb.style.opacity = config.opacity.toString();
                const slider = document.getElementById('opacity-slider') as HTMLInputElement;
                if (slider) {
                    slider.value = config.opacity.toString();
                    document.body.classList.toggle('opaque-keys-mode', config.opacity >= 0.99);
                }
            }
            if (config.themeOverrides) {
                const root = document.documentElement;
                Object.entries(config.themeOverrides).forEach(([prop, val]) => {
                    root.style.setProperty(prop, val as string);
                });
            }
        }
    } catch (e) {
        // 無現有設定，載入預設值

        isFirstBoot = true;
    }

    // 2. 根據確定後的設定進行渲染
    renderKeys();
    setupToolbar();
    setupLockPolling();

    // 3. Apply appearance and theme
    applyTheme(isDark);
    setupThemeListener();
    syncUIState();
    updateKeyboardDynamicMod();
    setupTooltips();

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
        if (config.w && !isReset) {
            const baseHeightStr = getComputedStyle(document.documentElement).getPropertyValue('--base-height');
            const baseWidthStr = getComputedStyle(document.documentElement).getPropertyValue('--base-width');
            const baseWidth = parseFloat(baseWidthStr) || (isFull ? 1078 : 723);
            const baseHeight = parseFloat(baseHeightStr) || (isFull ? 355 : 302);
            const targetHeight = Math.ceil(config.w * (baseHeight / baseWidth));

            isProgrammaticResize = true;
            try {
                await invoke('resize_window', { width: config.w, height: targetHeight });
            } finally {
                setTimeout(() => { isProgrammaticResize = false; }, 100);
            }
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

    // 監聽巨集執行狀態 (用於診斷與進度條)
    listen('macro_status', (e: any) => {
        const infoEl = document.getElementById('info-macro');
        const progressContainer = document.getElementById('macro-progress-container');
        const progressBar = document.getElementById('macro-progress-bar');
        
        if (infoEl) {
            infoEl.textContent = e.payload;
            
            // 顯示進度條
            if (progressContainer && progressBar) {
                progressContainer.style.display = 'block';
                
                // 解析進度字串 "🔄 進度: 1/10"
                const match = e.payload.match(/進度: (\d+)\/(\d+)/);
                if (match) {
                    const current = parseInt(match[1]);
                    const total = parseInt(match[2]);
                    const percent = (current / total) * 100;
                    progressBar.style.width = `${percent}%`;
                }
            }

            // 狀態完成後，一小段時間清空狀態
            if (e.payload.includes('完畢') || e.payload.includes('中斷')) {
                setTimeout(() => {
                    infoEl.textContent = '';
                    if (progressContainer) progressContainer.style.display = 'none';
                    if (progressBar) progressBar.style.width = '0%';
                }, 2000);
            }
        }
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
        if (isAutoTheme) {
            btnTheme.innerHTML = '🌓';
            btnTheme.setAttribute('data-tip', getIntegratedTip(btnTheme, '目前為自動模式 (點擊切換至淺色)'));
        } else {
            // 預覽型邏輯：手動深色時(isDark=true)顯示太陽☀️(點擊變亮)，手動淺色時(isDark=false)顯示月亮🌙(點擊變暗)
            btnTheme.innerHTML = isDark ? '☀️' : '🌙';
            btnTheme.setAttribute('data-tip', getIntegratedTip(btnTheme, isDark ? '目前為深色模式 (點擊切換至自動)' : '目前為淺色模式 (點擊切換至深色)'));
        }
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

        const baseHeightStr = getComputedStyle(document.documentElement).getPropertyValue('--base-height');
        const baseWidthStr = getComputedStyle(document.documentElement).getPropertyValue('--base-width');
        const baseWidth = parseFloat(baseWidthStr) || (isFull ? 1078 : 723);
        const baseHeight = parseFloat(baseHeightStr) || (isFull ? 355 : 302);

        const w = physicalSize.width / scaleFactor;
        const h = Math.ceil(w * (baseHeight / baseWidth));

        const config: OSKConfig = {
            compactLayout: userCompactLayout,
            fullLayout: userFullLayout,
            isFull: isFull,
            isDynamic: isDynamic,
            isPinned: isPinned,
            isZhuyinMode: isZhuyinMode,
            isDark: isDark,
            isAutoTheme: isAutoTheme,
            rX: relPos[0],
            rY: relPos[1],
            opacity: parseFloat((document.getElementById('opacity-slider') as HTMLInputElement).value || "1"),
            w: w,
            h: h,
            themeOverrides: {}
        };

        // 備份目前的自定義主題色
        const root = document.documentElement;
        const themeProps = ['--color-tl', '--color-tr', '--color-bl', '--color-br', '--color-num', '--text-main', '--key-bg'];
        themeProps.forEach(prop => {
            const val = root.style.getPropertyValue(prop);
            if (val && config.themeOverrides) config.themeOverrides[prop] = val;
        });

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
        colorDim: rootStyle.getPropertyValue('--color-dim').trim() || 'rgba(255,255,255,0.2)',
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
                w = Math.max(2, ((gridSpan / 270) * 1060) - gap);
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

    // 計算總高度：按鍵區域 + 工具列 (約 34px) + 上下 Padding (8px)
    const keysHeight = currentLayout.length * (rowHeight + gap) - gap;
    const baseHeight = keysHeight + 34 + 8;
    document.documentElement.style.setProperty('--base-height', `${baseHeight}px`);

    // 即時更新 Rust 端之長寬比限制
    invoke('update_aspect_ratio', { width: baseWidth, height: baseHeight }).catch(() => {});

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
                w = Math.max(2, ((gridSpan / 270) * 1060) - gap);
                currentWUnit += gridSpan;
            } else {
                x = Math.round(currentWUnit * 47);
                w = Math.round((currentWUnit + wUnit) * 47) - x - 5;
                currentWUnit += wUnit;
            }

            const h = (key.height === 2) ? (rowHeight * 2 + gap) : rowHeight;

            const rect = { x, y, w, h };
            if (!key.class?.includes('invisible')) {
                keyRects.push({ key, ...rect, row: rowIndex, col: colIndex });
            }

            // 繪製按鍵背景
            drawKey(ctx, key, rect, colors, isShift, isFn, isCaps, isNum, rowIndex, colIndex);
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
            drawKey(ctx, sourceKey, { x: 0, y: 0, w: sourceRect.w, h: sourceRect.h }, colors, isShift, isFn, isCaps, isNum, dragSourcePos.row, dragSourcePos.col);
            ctx.restore();
        }
    }
}

function drawKey(ctx: CanvasRenderingContext2D, key: KeyDefinition, rect: any, colors: any, isShift: boolean, isFn: boolean, isCaps: boolean, isNum: boolean, row: number, col: number) {
    if (key.class?.includes('invisible')) return;

    const isActive = pressedKey?.key === key || physicalPressedCodes.has(key.code);
    const isToggled = toggledModifiers.includes(key.code);
    
    // 編輯模式下的虛線提示鎖定邏輯
    const isEditing = editingKeyPos === `${row},${col}`;
    const isHover = hoverKey === key;
    const showEditHighlight = isEditing || (isEditMode && isHover && !editingKeyPos);

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

    // 1. 繪製底色
    if (isActive) {
        ctx.fillStyle = colors.keyActive;
    } else if (isToggled) {
        ctx.fillStyle = colors.keyToggle;
    } else if (key.bgColor) {
        ctx.fillStyle = key.bgColor;
    } else {
        ctx.fillStyle = isKeySpecial ? colors.keySpecialBg : colors.keyBg;
    }
    ctx.fill();

    // 2. 繪製 Hover/Drag 疊加層 (若有)
    if (isDragTarget) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
        ctx.fill();
    }

    // 邊框樣式
    ctx.strokeStyle = (isToggled || showEditHighlight || isDragTarget) ? colors.accent : (key.borderColor || colors.border);
    ctx.lineWidth = 1;
    if (isDragTarget) {
        ctx.lineWidth = 3;
        ctx.setLineDash([]); // 實線高亮
    } else if (showEditHighlight) {
        ctx.setLineDash([5, 3]);
        ctx.lineWidth = 2;
    }

    ctx.stroke();

    if (isHover && !isDragTarget) {
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.shadowColor = colors.accent;
        ctx.shadowBlur = 12;
        ctx.stroke();
        
        // 額外的內發光感
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.fill();
        ctx.restore();
    }

    if (isActive) {
        ctx.save();
        ctx.shadowColor = colors.accent;
        ctx.shadowBlur = 20;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
    }

    ctx.setLineDash([]); // 重置虛線
    ctx.restore();

    // --- 標籤繪製 ---
    const isAlpha = key.label.length === 1 && /^[a-zA-Z]$/.test(key.label);
    let centerChar = getCenterLabel(key, isShift, isFn, isCaps, isNum);
    
    // 靜態模式下，方向鍵、倒退鍵與 Esc 在 Fn 作用時不切換標籤，而是維持原標籤並調暗
    if (!isDynamic && isFn && [0x08, 0x1B, 0x25, 0x26, 0x27, 0x28].includes(key.code)) {
        centerChar = key.label;
    }
    
    const centerColor = getLabelColor(key, centerChar, colors, isShift, isFn, isCaps, isNum);

    if (isDynamic) {
        // 動態模式：只繪製中央標籤
        drawText(ctx, centerChar, rect.x + rect.w / 2, rect.y + rect.h / 2, centerColor, 24, "center", 1, rect.w - 10);
    } else {
        // 靜態模式：繪製四角標籤
        const isArrowOrBS = [0x08, 0x25, 0x26, 0x27, 0x28].includes(key.code);

        if (key.class?.includes('num-key')) {
            const navStr = key.sub || key.label;
            const numStr = key.label;
            const qX1 = rect.x + rect.w * 0.25;
            const qX2 = rect.x + rect.w * 0.75;
            const qY1 = rect.y + rect.h * 0.25;
            const qY2 = rect.y + rect.h * 0.75;
            // NumLock 狀態切換亮度
            drawText(ctx, navStr, qX1, qY1, key.tlColor || colors.colorTl, 20, "center", isNum ? 0.3 : 1, rect.w / 2 - 4);
            drawText(ctx, numStr, qX2, qY2, key.trColor || colors.colorNum, 20, "center", isNum ? 1 : 0.3, rect.w / 2 - 4);
        } else {
            // 一般按鍵、特殊鍵、方向鍵等：決定四個角落要顯示的內容
            const tlDisp = key.tl_ov?.display || key.label || '';
            const trDisp = key.tr_ov?.display || key.sub || '';
            const blDisp = key.bl_ov?.display || key.fn || '';
            const brDisp = key.br_ov?.display || key.zhPinyin || '';

            // 判斷是否「只有」左上角有內容 (包含 value)
            const hasTr = !!trDisp || !!key.tr_ov?.value;
            const hasBl = !!blDisp || !!key.bl_ov?.value;
            const hasBr = !!brDisp || !!key.br_ov?.value;
            const onlyTl = !!tlDisp && !hasTr && !hasBl && !hasBr;

            if (onlyTl && !isArrowOrBS) {
                // 只有設定左上角，顯示在中央 (保持原有特殊鍵或單一功能按鍵的行為)
                drawText(ctx, centerChar, rect.x + rect.w / 2, rect.y + rect.h / 2, centerColor, 24, "center", 1, rect.w - 10);
            } else {
                // 有多個角落設定，分別畫在對應角落
                // 判斷當前模式下的高亮
                let highlight = "tl";
                if (isFn && hasBl) highlight = "bl";
                else if (isShift && hasTr) highlight = "tr";
                else if (isZhuyinMode && hasBr) highlight = "br";
                else if (isCaps && isAlpha) highlight = "tr";

                if (isArrowOrBS) {
                    // 方向鍵/倒退鍵在中央顯示當前狀態的圖示，角落顯示其他設定
                    drawText(ctx, centerChar, rect.x + rect.w / 2, rect.y + rect.h / 2, centerColor, 24, "center", 1, rect.w - 10);
                    // 畫其他角落 (但不畫 TL)
                    const qX2 = rect.x + rect.w * 0.75;
                    const qY1 = rect.y + rect.h * 0.25;
                    const qX1 = rect.x + rect.w * 0.25;
                    const qY2 = rect.y + rect.h * 0.75;
                    if (trDisp) drawText(ctx, trDisp, qX2, qY1, key.trColor || colors.colorTr, 20, "center", highlight === "tr" ? 1 : 0.3, rect.w / 2 - 4);
                    if (blDisp) drawText(ctx, blDisp, qX1, qY2, key.blColor || colors.colorBl, 20, "center", highlight === "bl" ? 1 : 0.3, rect.w / 2 - 4);
                    if (brDisp) drawText(ctx, brDisp, qX2, qY2, key.brColor || colors.colorBr, 20, "center", highlight === "br" ? 1 : 0.3, rect.w / 2 - 4);
                } else {
                    const qX1 = rect.x + rect.w * 0.25;
                    const qX2 = rect.x + rect.w * 0.75;
                    const qY1 = rect.y + rect.h * 0.25;
                    const qY2 = rect.y + rect.h * 0.75;
                    const cSize = 20;
                    const maxW = rect.w / 2 - 4;

                    if (tlDisp) drawText(ctx, tlDisp, qX1, qY1, key.tlColor || colors.colorTl, cSize, "center", highlight === "tl" ? 1 : 0.3, maxW);
                    if (trDisp) drawText(ctx, trDisp, qX2, qY1, key.trColor || colors.colorTr, cSize, "center", highlight === "tr" ? 1 : 0.3, maxW);
                    if (blDisp) drawText(ctx, blDisp, qX1, qY2, key.blColor || colors.colorBl, cSize, "center", highlight === "bl" ? 1 : 0.3, maxW);
                    if (brDisp) drawText(ctx, brDisp, qX2, qY2, key.brColor || colors.colorBr, cSize, "center", highlight === "br" ? 1 : 0.3, maxW);
                }
            }
        }
    }

    // 繪製循環指示器 ▶️
    if (isMacroLooping && loopingKey === key) {
        ctx.save();
        // 繪製覆蓋背景以遮擋原標籤
        ctx.fillStyle = colors.bg;
        ctx.beginPath();
        const radius = 10;
        // @ts-ignore
        if (ctx.roundRect) ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
        else ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.fill();

        // 繪製邊框以保持一致性
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = colors.accent;
        ctx.font = "bold 32px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("▶️", rect.x + rect.w / 2, rect.y + rect.h / 2);
        ctx.restore();
    }
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, align: "left" | "right" | "center", opacity: number = 1, maxW?: number) {
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
    
    if (isFn && (key.bl_ov?.value || key.bl_ov?.display || key.fn)) {
        return key.bl_ov?.display || key.fn || '';
    }
    if (isShift && (key.tr_ov?.value || key.tr_ov?.display || key.sub || isAlpha)) {
        return key.tr_ov?.display || key.sub || (isAlpha ? key.label.toUpperCase() : key.label);
    }
    if (isZhuyinMode && (key.br_ov?.value || key.br_ov?.display || key.zhPinyin)) {
        return key.br_ov?.display || key.zhPinyin || '';
    }
    if (isCaps && isAlpha) return key.label.toUpperCase();
    
    if (key.class?.includes('num-key')) {
        if (isNum) {
            return key.tl_ov?.display || key.label;
        } else {
            return key.tr_ov?.display || key.sub || key.label;
        }
    }

    return key.tl_ov?.display || (key.special ? key.label : key.label.toLowerCase());
}

function getLabelColor(key: KeyDefinition, char: string, colors: any, isShift: boolean, isFn: boolean, isCaps: boolean, isNum: boolean): string {
    const isAlpha = key.label.length === 1 && /^[a-zA-Z]$/.test(key.label);
    const isSpecial = key.special || key.class?.includes('special') || key.class?.includes('space');

    // 0. 修飾鍵始終顯示預覽型配色
    if (key.code === 0xFE) return key.blColor || colors.colorBl; // Fn
    if (key.code === 0xA0 || key.code === 0xA1 || key.code === 0x14) return key.trColor || colors.colorTr; // Shift/Caps
    if (key.code === 0x90) return key.trColor || colors.colorNum; // NumLock
    if (key.code === 0x5D) return key.brColor || colors.colorBr; // Mode Toggle (ㄅ/En)

    const blTarget = key.bl_ov?.display || key.fn || '';
    const trTarget = key.tr_ov?.display || key.sub || (isAlpha ? key.label.toUpperCase() : key.label);
    const brTarget = key.br_ov?.display || key.zhPinyin || '';

    // 1. 處理自定義多角顏色
    if (isFn && (key.bl_ov?.value || key.bl_ov?.display || key.fn) && char === blTarget) return key.blColor || colors.colorBl;
    if (isShift && (key.tr_ov?.value || key.tr_ov?.display || key.sub || isAlpha) && char === trTarget) {
        // 確保 Shift 不影響數字九宮格的自定義主顏色
        if (key.class?.includes('num-key')) return key.tlColor || colors.colorTl;
        return key.trColor || colors.colorTr;
    }
    if (isZhuyinMode && (key.br_ov?.value || key.br_ov?.display || key.zhPinyin) && char === brTarget) return key.brColor || colors.colorBr;
    if (isCaps && isAlpha && char === key.label.toUpperCase()) return key.trColor || colors.colorTr;

    // 2. 處理數字九宮格狀態 (確保導航與數字模式顏色一致)
    if (key.class?.includes('num-key')) {
        if (isDynamic) {
            // 動態模式：根據 NumLock 狀態切換標籤與顏色
            return isNum ? (key.trColor || colors.colorNum) : (key.tlColor || colors.colorTl);
        }
        return key.tlColor || colors.colorTl;
    }

    // 3. 處理無多角屬性的功能鍵
    // 透過比對 overrides 判斷是否需要套用角落顏色
    const hasMultipleCorners = (key.sub || key.fn || key.zhPinyin || key.tr_ov || key.bl_ov || key.br_ov);
    if (isSpecial && !hasMultipleCorners) {
        if (key.code === 0x5D && !isZhuyinMode) return key.brColor || colors.colorBr;
        return key.tlColor || colors.colorTl;
    }

    // 4. 套用全域預設顏色與高亮邏輯
    if (isFn) {
        if ((key.bl_ov?.value || key.bl_ov?.display || key.fn) && char === blTarget) return key.blColor || colors.colorBl;
        if (!key.fn && !key.bl_ov?.display && !key.bl_ov?.value) return key.tlColor || colors.colorTl;
        return colors.colorDim;
    }
    if (isShift && (key.tr_ov?.value || key.tr_ov?.display || key.sub || isAlpha)) return colors.colorTr;
    if (isZhuyinMode && (key.br_ov?.value || key.br_ov?.display || key.zhPinyin)) return colors.colorBr;
    if (isCaps && isAlpha) return colors.colorTr;

    // 5. 預設顏色
    return key.tlColor || colors.colorTl;
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

    canvas.addEventListener('mouseleave', () => {
        hoverKey = null;
        renderKeys();
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

        if (isEditMode && longPressTimer && !isDraggingKey) {
            const rect = canvas.getBoundingClientRect();
            const appScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale') || "1");
            const x = (e.clientX - rect.left) / appScale;
            const y = (e.clientY - rect.top) / appScale;
            const hit = keyRects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

            if (hit && lastEditorData) {
                const keyCode = hit.key.code;
                const k = hit.key;
                
                // 檢查是否與當前編輯器顏色完全相同 (用來判斷是否需要恢復原色)
                const isMatchingEditor = 
                    k.tlColor === lastEditorData.tlColor &&
                    k.trColor === lastEditorData.trColor &&
                    k.blColor === lastEditorData.blColor &&
                    k.brColor === lastEditorData.brColor &&
                    k.bgColor === lastEditorData.bgColor &&
                    k.borderColor === lastEditorData.borderColor;

                if (isMatchingEditor && batchOriginalStates.has(keyCode)) {
                    // 恢復原色
                    const original = batchOriginalStates.get(keyCode);
                    [userCompactLayout, userFullLayout].forEach(layout => {
                        layout.forEach(row => row.forEach(key => {
                            if (key.code === keyCode) {
                                key.tlColor = original.tlColor;
                                key.trColor = original.trColor;
                                key.blColor = original.blColor;
                                key.brColor = original.brColor;
                                key.bgColor = original.bgColor;
                                key.borderColor = original.borderColor;
                            }
                        }));
                    });
                } else {
                    // 套用新色，並在第一次變動時紀錄原色
                    if (!batchOriginalStates.has(keyCode)) {
                        batchOriginalStates.set(keyCode, {
                            tlColor: k.tlColor,
                            trColor: k.trColor,
                            blColor: k.blColor,
                            brColor: k.brColor,
                            bgColor: k.bgColor,
                            borderColor: k.borderColor
                        });
                    }

                    [userCompactLayout, userFullLayout].forEach(layout => {
                        layout.forEach(row => row.forEach(key => {
                            if (key.code === keyCode) {
                                key.tlColor = lastEditorData.tlColor;
                                key.trColor = lastEditorData.trColor;
                                key.blColor = lastEditorData.blColor;
                                key.brColor = lastEditorData.brColor;
                                key.bgColor = lastEditorData.bgColor;
                                key.borderColor = lastEditorData.borderColor;
                            }
                        }));
                    });
                }
                await saveCurrentConfig();
            }
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

function initWindowInteraction() {
    // 視窗拖曳與縮放現在改由後端 Rust 的 wndproc (WM_NCHITTEST & WM_NCLBUTTONDOWN) 自動處理。
    // 這能完美支援觸控與滑鼠，同時避免 Windows 預設的視覺瑕疵。
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
        if (isMacroLooping && loopingKey === key) {
            invoke('stop_macro');
            return;
        }

        if (override.isDirect) {
            // 提供視覺回饋：在資訊列閃爍一下 📋
            const clipEl = document.getElementById('info-clipboard');
            if (clipEl) {
                clipEl.style.transition = 'none';
                clipEl.style.color = 'var(--accent)';
                clipEl.style.textShadow = '0 0 10px var(--accent)';
                setTimeout(() => {
                    clipEl.style.transition = 'color 0.5s ease, text-shadow 0.5s ease';
                    clipEl.style.color = '';
                    clipEl.style.textShadow = '';
                }, 50);
            }
            invoke('type_text', { text: override.value });
            return;
        }

        const vks = parseKeyValue(override.value);
        if (vks.length > 1) {
            invoke('simulate_combination', { vkCodes: vks });
            return;
        } else if (vks.length === 1) {
            invoke('simulate_key', { vkCode: vks[0], isKeyUp: false });
            return;
        } else if (override.value.trim().length > 0) {
            invoke('execute_app', { cmd: override.value.trim(), startVk: key.code });
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
            if (override.isDirect) return;
            const vks = parseKeyValue(override.value);
            if (vks.length === 1) {
                await invoke('simulate_key', { vkCode: vks[0], isKeyUp: true });
                return;
            } else if (vks.length > 1 || override.value.trim().length > 0) {
                // If it's a combination or a command, do nothing on release
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
    longPressTimer = setTimeout(async () => {
        longPressTimer = null;
        if (editorWindow && await editorWindow.isVisible()) {
            return;
        }
        editingKeyPos = `${hit.row},${hit.col}`;
        await openKeyEditor(hit.key);
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
    if (input.includes(',')) return []; // 巨集格式，跳過單鍵解析交由 execute_app 處理
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

function getDefaultKeyValue(key: KeyDefinition, corner: 'tl' | 'tr' | 'bl' | 'br'): string {
    if (corner === 'tl') return `0x${key.code.toString(16)}`;
    if (corner === 'tr') return key.sub ? `Shift+0x${key.code.toString(16)}` : "";
    if (corner === 'bl') {
        if (!key.fn) return "";
        if (key.fn.startsWith('F')) {
            const fNum = parseInt(key.fn.substring(1));
            return `0x${(0x6F + fNum).toString(16)}`;
        }
        if (fnKeyMap[key.fn]) return `0x${fnKeyMap[key.fn].toString(16)}`;
        return "";
    }
    return "";
}

let editorWindow: WebviewWindow | null = null;
let currentlyEditingKey: any = null;

/** 自動調整高度以符合內容 */
const syncTextareaHeight = (el: HTMLTextAreaElement) => {

    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
};

listen('request-key', () => {
    if (currentlyEditingKey) {
        emit('load-key', currentlyEditingKey);
    }
});

async function openKeyEditor(key: KeyDefinition) {
    const isShift = toggledModifiers.includes(0xA0) || toggledModifiers.includes(0xA1);
    const isFn = toggledModifiers.includes(0xFE);
    const isCaps = toggledModifiers.includes(0x14);
    const isNum = toggledModifiers.includes(0x90);

    currentlyEditingKey = { key, isDark, isDynamic, isFull, isZhuyinMode, modifiers: { isShift, isFn, isCaps, isNum } };
    batchOriginalStates.clear();
    
    // 初始化快速套用資料
    const defaultBg = isDark ? '#1e293b' : '#ffffff';
    const defaultTl = isDark ? '#f8fafc' : '#0f172a';
    const defaultTr = isDark ? '#38bdf8' : '#0369a1';
    const defaultBl = isDark ? '#4ade80' : '#15803d';
    const defaultBr = isDark ? '#fbbf24' : '#b45309';

    lastEditorData = {
        tlColor: key.tlColor || defaultTl,
        trColor: key.trColor || defaultTr,
        blColor: key.blColor || defaultBl,
        brColor: key.brColor || defaultBr,
        bgColor: key.bgColor || defaultBg,
        borderColor: key.borderColor || (isDark ? '#475569' : '#e2e8f0')
    };

    let win = await WebviewWindow.getByLabel('key-editor');
    if (win) {
        await win.close();
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    const mainWin = getCurrentWindow();
    const kbPos = await mainWin.outerPosition();
    const kbSize = await mainWin.outerSize();
    const dpr = window.devicePixelRatio || 1;
    const editorW_log = 480;
    const editorH_log = 620; 
    
    const editorW_phys = Math.round(editorW_log * dpr);
    const editorH_phys = Math.round(editorH_log * dpr);

    let editorX_phys = Math.round(kbPos.x + (kbSize.width - editorW_phys) / 2);
    let editorY_phys = Math.round(kbPos.y - editorH_phys);
    
    // 使用網頁 API 獲取當前螢幕的實體邊界
    const screenW_phys = window.screen.availWidth * dpr;
    const screenH_phys = window.screen.availHeight * dpr;

    // 如果上方空間不足，嘗試放在下方
    if (editorY_phys < 0) {
        editorY_phys = kbPos.y + kbSize.height;
    }
    
    // 如果放在下方會超出螢幕底部，則強制貼齊螢幕底部
    if (editorY_phys + editorH_phys > screenH_phys) {
        editorY_phys = screenH_phys - editorH_phys;
        // 極端情況：如果螢幕高度比編輯器還小，貼齊頂部
        if (editorY_phys < 0) {
            editorY_phys = 0;
        }
    }
    
    // 確保 X 軸不超出螢幕左右邊界
    if (editorX_phys < 0) {
        editorX_phys = 0;
    } else if (editorX_phys + editorW_phys > screenW_phys) {
        editorX_phys = screenW_phys - editorW_phys;
    }

    const editorX_log = Math.round(editorX_phys / dpr);
    const editorY_log = Math.round(editorY_phys / dpr);

    editorWindow = new WebviewWindow('key-editor', {
        url: 'index.html?mode=editor',
        title: '編輯按鍵設定',
        width: editorW_log,
        height: editorH_log,
        x: editorX_log,
        y: editorY_log,
        resizable: true,
        alwaysOnTop: true,
        decorations: true
    });

    const newWin = editorWindow;
    
    newWin.once('tauri://created', () => {
        document.getElementById('toolbar')?.classList.add('editing-mode');
        emit('load-key', currentlyEditingKey);
    });

    newWin.once('tauri://error', (e) => {
        console.error("Failed to create editor window", e);
        editorWindow = null;
        document.getElementById('toolbar')?.classList.remove('editing-mode');
    });

    newWin.onCloseRequested(async () => {
        editorWindow = null;
        editingKeyPos = null;
        currentlyEditingKey = null;
        document.getElementById('toolbar')?.classList.remove('editing-mode');
        saveCurrentConfig();
    });
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
        currentLayout = isFull ? userFullLayout : userCompactLayout;

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
        const confirmed = await ask("確定要將所有按鍵佈局、視窗位置與透明度恢復為預設值嗎？\n這將會重新啟動程式，且現有的設定檔將會被自動備份。", {
            title: '重置警告',
            kind: 'warning',
        });

        if (confirmed) {


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
        // 如果編輯視窗已開啟且可見，則鎖定狀態不允許關閉
        if (editorWindow && await editorWindow.isVisible()) {
            return;
        }
        const entering = !isEditMode;
        isEditMode = entering;
        if (!entering && editorWindow) {
            editorWindow.close();
            editorWindow = null;
        }

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

    // No JS dragging logic here, using native app-region: drag in style.css


    btnTheme?.addEventListener('click', async () => {
        if (isAutoTheme) {
            // 自動 -> 變為手動淺色
            isAutoTheme = false;
            isDark = false;
        } else if (!isDark) {
            // 手動淺色 -> 變為手動深色
            isDark = true;
        } else {
            // 手動深色 -> 變為自動
            isAutoTheme = true;
            isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        applyTheme(isDark);
        syncUIState();
        renderKeys();
        await saveCurrentConfig();
    });

    opacitySlider?.addEventListener('input', async () => {
        const val = parseFloat(opacitySlider.value);
        if (keyboardNode) keyboardNode.style.opacity = val.toString();
        
        // 當透明度為 1 時，切換為按鍵不透明模式
        const isOpaque = val >= 0.99;
        const wasOpaque = document.body.classList.contains('opaque-keys-mode');
        if (isOpaque !== wasOpaque) {
            document.body.classList.toggle('opaque-keys-mode', isOpaque);
            applyTheme(isDark);
            renderKeys();
        }

        await saveCurrentConfig();
    });

    btnClose?.addEventListener('click', () => { invoke('force_exit'); });



    // Editor events now managed by separate window.
    syncUIState(); // 初始化圖示狀態
}

function applyTheme(dark: boolean) {
    const root = document.documentElement;
    const isOpaqueKeys = document.body.classList.contains('opaque-keys-mode');

    if (dark) {
        root.style.setProperty('--bg-color', 'rgb(15, 23, 42)');
        root.style.setProperty('--kb-bg-gradient', 'linear-gradient(135deg, rgba(15, 23, 42, 0.8), rgba(30, 41, 59, 0.7))');
        root.style.setProperty('--toolbar-bg', 'rgba(0, 0, 0, 0.2)');
        
        // 編輯器配色 (深色)
        root.style.setProperty('--modal-bg', 'rgba(15, 23, 42, 0.95)');
        root.style.setProperty('--section-bg', 'rgba(255, 255, 255, 0.04)');
        root.style.setProperty('--input-bg', 'rgba(0, 0, 0, 0.25)');
        root.style.setProperty('--help-bg', 'rgba(0, 0, 0, 0.3)');
        root.style.setProperty('--help-border', 'rgba(255, 255, 255, 0.1)');
        root.style.setProperty('--code-bg', 'rgba(255, 255, 255, 0.1)');

        if (isOpaqueKeys) {
            // 不透明模式下使用實色 (大約是 8% white 混入背景後的結果)
            root.style.setProperty('--key-bg', 'rgb(34, 41, 59)');
            root.style.setProperty('--key-special-bg', 'rgb(25, 32, 50)');
        } else {
            root.style.setProperty('--key-bg', 'rgba(255, 255, 255, 0.08)');
            root.style.setProperty('--key-special-bg', 'rgba(255, 255, 255, 0.04)');
        }
        
        root.style.setProperty('--key-active', 'rgba(56, 189, 248, 0.4)');
        root.style.setProperty('--key-toggle', 'rgba(56, 189, 248, 0.2)');
        root.style.setProperty('--text-main', '#f8fafc');
        root.style.setProperty('--text-sub', '#94a3b8');
        root.style.setProperty('--border-color', 'rgba(255, 255, 255, 0.1)');
        root.style.setProperty('--accent', '#38bdf8');
        
        // Tooltip 配色 (深色主題)
        root.style.setProperty('--tooltip-bg', 'rgba(15, 23, 42, 0.95)');
        root.style.setProperty('--tooltip-color', '#f8fafc');
        root.style.setProperty('--tooltip-border', 'rgba(255, 255, 255, 0.2)');

        root.style.setProperty('--color-tl', '#f8fafc');
        root.style.setProperty('--color-tr', '#38bdf8');
        root.style.setProperty('--color-bl', '#4ade80');
        root.style.setProperty('--color-br', '#fbbf24');
        root.style.setProperty('--color-num', '#bae6fd');

        root.style.setProperty('--corner-opacity', '0.8');
        root.style.setProperty('--corner-weight', '600');
        root.style.setProperty('--color-dim', 'rgba(255, 255, 255, 0.2)');
    } else {
        root.style.setProperty('--bg-color', '#f1f5f9');
        root.style.setProperty('--kb-bg-gradient', 'linear-gradient(135deg, rgba(241, 245, 249, 0.9), rgba(226, 232, 240, 0.85))');
        root.style.setProperty('--toolbar-bg', 'rgba(255, 255, 255, 0.3)');

        // 編輯器配色 (淺色)
        root.style.setProperty('--modal-bg', 'rgba(255, 255, 255, 0.98)');
        root.style.setProperty('--section-bg', 'rgba(0, 0, 0, 0.03)');
        root.style.setProperty('--input-bg', '#ffffff');
        root.style.setProperty('--help-bg', '#e2e8f0');
        root.style.setProperty('--help-border', 'rgba(0, 0, 0, 0.05)');
        root.style.setProperty('--code-bg', 'rgba(0, 0, 0, 0.05)');

        if (isOpaqueKeys) {
            root.style.setProperty('--key-bg', '#ffffff');
            root.style.setProperty('--key-special-bg', '#f8fafc');
            root.style.setProperty('--border-color', 'rgba(0, 0, 0, 0.15)'); // 實體模式下邊框更明顯
        } else {
            root.style.setProperty('--key-bg', '#ffffff');
            root.style.setProperty('--key-special-bg', '#e2e8f0');
            root.style.setProperty('--border-color', 'rgba(0, 0, 0, 0.08)');
        }

        root.style.setProperty('--key-active', 'rgba(2, 132, 199, 0.3)');
        root.style.setProperty('--key-toggle', 'rgba(2, 132, 199, 0.15)');
        root.style.setProperty('--text-main', '#0f172a');
        root.style.setProperty('--text-sub', '#475569');
        root.style.setProperty('--accent', '#0284c7');

        // Tooltip 配色 (淺色主題恢復為白底黑字)
        root.style.setProperty('--tooltip-bg', 'rgba(255, 255, 255, 0.98)');
        root.style.setProperty('--tooltip-color', '#0f172a');
        root.style.setProperty('--tooltip-border', 'rgba(0, 0, 0, 0.15)');

        root.style.setProperty('--color-tl', '#0f172a');
        root.style.setProperty('--color-tr', '#0369a1');
        root.style.setProperty('--color-bl', '#15803d');
        root.style.setProperty('--color-br', '#b45309');
        root.style.setProperty('--color-num', '#0369a1');

        root.style.setProperty('--corner-opacity', '1.0');
        root.style.setProperty('--corner-weight', '700');
    }
}

function setupThemeListener() {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', (e) => {
        if (isAutoTheme) {
            isDark = e.matches;
            applyTheme(isDark);
            syncUIState();
            renderKeys();
            // 不自動存檔以避免系統短暫切換造成 config 頻繁寫入，僅在 UI 同步
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const isEditor = window.location.search.includes('mode=editor');
    if (isEditor) {
        try {
            initEditorWindowMode();
        } catch (e: any) {
            alert("Editor init error: " + e.message);
        }
        return;
    }

    await initApp();
    initCanvasEvents();
    initWindowInteraction();

    listen('editor-update', (e: any) => {
        lastEditorData = e.payload;
        if (!editingKeyPos) return;
        const [r, c] = editingKeyPos.split(',').map(Number);
        const targetKey = currentLayout[r][c];
        const keyCode = targetKey.code;

        // 同步更新所有版面中鍵值相同的按鍵 (例如 60% 與 100% 同時連動)
        [userCompactLayout, userFullLayout].forEach(layout => {
            layout.forEach(row => row.forEach(k => {
                if (k.code === keyCode) {
                    Object.assign(k, e.payload);
                }
            }));
        });
        
        renderKeys();
    });

    listen('editor-apply-all', async (e: any) => {
        const payload = e.payload;
        const updates = payload.updates || [{ prop: payload.prop, color: payload.color }];
        const isNumKey = !!currentlyEditingKey?.key?.class?.includes('num-key');

        [userCompactLayout, userFullLayout].forEach(layout => {
            layout.forEach(row => row.forEach(k => {
                const targetIsNum = !!k.class?.includes('num-key');
                // 區分區域套用邏輯 (避免九宮格與主鍵盤顏色互相干擾)
                if (isNumKey === targetIsNum) {
                    updates.forEach(({ prop, color }: any) => {
                        (k as any)[prop] = color;
                    });
                }
            }));
        });
        const root = document.documentElement;
        // 僅同步主鍵盤變數至全域主題色
        if (!isNumKey) {
            updates.forEach(({ prop, color }: any) => {
                if (prop === 'tlColor') { root.style.setProperty('--color-tl', color); root.style.setProperty('--text-main', color); }
                else if (prop === 'trColor') { root.style.setProperty('--color-tr', color); root.style.setProperty('--color-num', color); }
                else if (prop === 'blColor') { root.style.setProperty('--color-bl', color); }
                else if (prop === 'brColor') { root.style.setProperty('--color-br', color); }
                else if (prop === 'bgColor') { root.style.setProperty('--key-bg', color); }
                else if (prop === 'borderColor') { root.style.setProperty('--border-color', color); }
            });
        }
        renderKeys();
        await saveCurrentConfig();
    });

    listen('editor-save', async () => {
        await saveCurrentConfig();
    });

    listen('editor-closed', () => {
        document.getElementById('toolbar')?.classList.remove('hidden');
    });

    // 監聽來自 Rust 的外部狀態改變要求 (例如系統列選單操作)
    listen('backend_pin_updated', async (e: any) => {
        isPinned = e.payload === true;
        syncUIState();
        await saveCurrentConfig();
    });

    listen('macro_loop_status', (e: any) => {
        const { active, vk } = e.payload;
        isMacroLooping = active;
        if (active) {
            // 尋找對應的 KeyDefinition
            loopingKey = null;
            for (const row of currentLayout) {
                for (const k of row) {
                    if (k.code === vk) {
                        loopingKey = k;
                        break;
                    }
                }
                if (loopingKey) break;
            }
            document.querySelector('.toolbar-right')?.classList.add('hidden');
            document.querySelector('.toolbar-spacer')?.classList.add('hidden');
        } else {
            loopingKey = null;
            document.querySelector('.toolbar-right')?.classList.remove('hidden');
            document.querySelector('.toolbar-spacer')?.classList.remove('hidden');
        }
        renderKeys();
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
    let resizeSnapTimeout: any = null;
    window.addEventListener('resize', () => {
        if (isProgrammaticResize) return;

        userAdjustedSize = true;
        updateAppScale();
        renderKeys(); // 視窗縮放時重繪 Canvas

        if (moveTimeout) clearTimeout(moveTimeout);
        moveTimeout = setTimeout(() => {
            saveCurrentConfig();
        }, 500);

        if (resizeSnapTimeout) clearTimeout(resizeSnapTimeout);
        resizeSnapTimeout = setTimeout(async () => {
            if (isProgrammaticResize || isEditMode) return;
            const baseHeightStr = getComputedStyle(document.documentElement).getPropertyValue('--base-height');
            const baseWidthStr = getComputedStyle(document.documentElement).getPropertyValue('--base-width');
            const baseWidth = parseFloat(baseWidthStr) || (isFull ? 1078 : 723);
            const baseHeight = parseFloat(baseHeightStr) || (isFull ? 355 : 302);
            const currentScale = window.innerWidth / baseWidth;
            const targetHeight = Math.ceil(baseHeight * currentScale);

            if (Math.abs(window.innerHeight - targetHeight) > 2) {
                isProgrammaticResize = true;
                try {
                    await invoke('resize_window', { width: window.innerWidth, height: targetHeight });
                } finally {
                    setTimeout(() => { isProgrammaticResize = false; }, 100);
                }
            }
        }, 150);
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

    // 清理所有原生 title
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

    const updatePosition = (target: HTMLElement) => {
        const rect = target.getBoundingClientRect();
        const tipRect = tooltip.getBoundingClientRect();
        
        let left = rect.left + rect.width / 2;
        let top = rect.bottom + 8;

        // 邊界檢查：避免超出視窗右側
        if (left + tipRect.width / 2 > window.innerWidth - 10) {
            left = window.innerWidth - tipRect.width / 2 - 10;
        }
        // 邊界檢查：避免超出視窗左側
        if (left - tipRect.width / 2 < 10) {
            left = tipRect.width / 2 + 10;
        }
        // 邊界檢查：避免超出視窗底部
        if (top + tipRect.height > window.innerHeight - 10) {
            top = rect.top - tipRect.height - 8;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltip.style.transform = `translateX(-50%) translateY(0)`;
    };

    const hideTooltip = () => {
        currentHoverTarget = null;
        tooltip.classList.remove('visible');
    };

    const showTooltip = (target: HTMLElement) => {
        currentHoverTarget = target;
        const tip = target.getAttribute('data-tip');
        if (!tip) {
            hideTooltip();
            return;
        }
        
        tooltip.textContent = tip;
        tooltip.classList.add('visible');
        // 必須先顯示才能獲取正確的 tipRect
        updatePosition(target);
    };

    // 使用事件代理處理所有 data-tip
    document.addEventListener('mouseover', (e) => {
        const target = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement;
        if (target) {
            showTooltip(target);
        }
    });

    document.addEventListener('mousemove', () => {
        if (!currentHoverTarget) return;
        
        // 如果還在同一個目標上，且 tooltip 可見，則更新位置（處理可能發生的佈局變動）
        if (tooltip.classList.contains('visible')) {
            updatePosition(currentHoverTarget);
        }
    });

    document.addEventListener('mouseout', (e) => {
        const target = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement;
        if (target && target === currentHoverTarget) {
            const related = e.relatedTarget as HTMLElement;
            if (!related || !target.contains(related)) {
                hideTooltip();
            }
        }
    });

    // 特別針對 Canvas (按鍵區) 增加強制清除
    const canvas = document.getElementById('keyboard-canvas');
    if (canvas) {
        canvas.addEventListener('mouseenter', hideTooltip);
        canvas.addEventListener('mousemove', () => {
            if (currentHoverTarget) hideTooltip();
        });
    }

    window.addEventListener('mouseleave', hideTooltip);
    window.addEventListener('blur', hideTooltip);
    
    // 監聽視窗事件
    const win = getCurrentWindow() as any;
    win.listen('tauri://mouseleave', hideTooltip);
    win.listen('tauri://blur', hideTooltip);

    // 究極防護：定時監控機制 (Watchdog)
    setInterval(() => {
        if (currentHoverTarget) {
            if (!currentHoverTarget.matches(':hover')) {
                hideTooltip();
            }
        }
    }, 150);
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
            tooltip.classList.add('visible');
            const rect = currentHoverTarget.getBoundingClientRect();
            const left = rect.left + rect.width / 2;
            const top = rect.bottom + 8;
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        } else {
            tooltip.classList.remove('visible');
        }
    }
}

async function initEditorWindowMode() {
    // 載入設定以確保主題同步
    const savedData = await invoke<string>('load_config');
    const config = JSON.parse(savedData);
    if (config) {
        isAutoTheme = config.isAutoTheme !== undefined ? Boolean(config.isAutoTheme) : true;
        if (isAutoTheme) {
            isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        } else {
            isDark = config.isDark !== undefined ? Boolean(config.isDark) : true;
        }
    }
    
    applyTheme(isDark);
    setupThemeListener();

    const kb = document.getElementById('keyboard');
    if (kb) kb.style.display = 'none';
    
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    document.body.classList.add('editor-window');
    document.documentElement.classList.add('editor-window');
    
    const modal = document.getElementById('key-editor-modal');
    if (modal) {
        modal.classList.add('active');
        modal.style.background = 'var(--bg-color)';
        modal.style.position = 'relative';
        modal.style.width = '100vw';
        modal.style.minHeight = '100vh';
        modal.style.height = 'auto';
        modal.style.transform = 'none';
        modal.style.maxWidth = 'none';
        modal.style.borderRadius = '0';
        modal.style.border = 'none';
        
        const content = modal.querySelector('.modal-content') as HTMLElement;
        if (content) {
            content.style.transform = 'none';
            content.style.width = '100%';
            content.style.minHeight = '100%';
            content.style.height = 'auto';
            content.style.boxSizing = 'border-box';
            content.style.borderRadius = '0';
            content.style.border = 'none';
            content.style.maxWidth = '100%';
        }
        
        // 隱藏自訂的關閉按鈕，因為系統標題列已有關閉按鈕
        const closeBtn = document.getElementById('btn-close-modal');
        if (closeBtn) {
            closeBtn.style.display = 'none';
        }

        // 綁定編輯視窗內的 SOS 按鈕
        const btnEditorSos = document.getElementById('btn-editor-sos');
        if (btnEditorSos) {
            btnEditorSos.addEventListener('click', async () => {
                await invoke('release_all_modifiers');
                invoke('open_sos');
            });
        }

        // 綁定編輯視窗內的 Help 按鈕
        const btnEditorHelp = document.getElementById('btn-editor-help');
        const helpBox = document.getElementById('editor-help-box');
        if (btnEditorHelp && helpBox) {
            btnEditorHelp.addEventListener('click', () => {
                const isHidden = helpBox.style.display === 'none';
                helpBox.style.display = isHidden ? 'block' : 'none';
                btnEditorHelp.classList.toggle('active-tool', isHidden);
            });
        }

        // --- 錄製邏輯變數 ---
        let hasUsedModifierInCombo = false;


        const recordMacroStep = (comboStr: string) => {
            if (!recordingTargetId) return;
            const input = document.getElementById(recordingTargetId) as HTMLInputElement;
            if (!input) return;

            let val = input.value.trim();
            // 偵測是否已有無限循環指令 l
            let hasLoop = false;
            if (val.endsWith(',l')) {
                val = val.substring(0, val.length - 2);
                hasLoop = true;
            } else if (val === 'l') {
                val = "";
                hasLoop = true;
            }

            const now = Date.now();
            if (val.length === 0) {
                val = comboStr;
            } else {
                const delta = now - lastRecordTime;
                val += `,w${Math.min(delta, 99999)},${comboStr}`;
            }

            // 如果原本有循環指令，重新補回末端
            if (hasLoop) {
                val += ',l';
            }
            
            input.value = val;
            lastRecordTime = now;

            const corner = recordingTargetId.split('-')[1];
            const statusEl = document.getElementById(`status-record-${corner}`);
            if (statusEl) statusEl.textContent = `🔴 錄製中 (${comboStr})...`;

            input.dispatchEvent(new Event('input'));
            updatePreview();
        };

        /** 混和錄製模式：結合 DOM 事件與系統 Hook 確保錄製成功率 */

        
        let activeVkModifiers = new Set<number>();
        let lastProcessedKey = "";
        let lastProcessedTime = 0;

        const processKeyRecord = (comboStr: string) => {
            const now = Date.now();
            // 防止同一個按鍵在極短時間內被 DOM 與 Rust 同時觸發導致重複錄製
            if (comboStr === lastProcessedKey && now - lastProcessedTime < 50) {
                return;
            }
            lastProcessedKey = comboStr;
            lastProcessedTime = now;
            recordMacroStep(comboStr);
        };

        listen('physical_key', (event: any) => {
            if (!recordingTargetId) return;
            const { code, is_down } = event.payload;
            

            
            const isMod = (c: number) => [0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5].includes(c);
            
            if (is_down) {
                if (isMod(code)) {
                    activeVkModifiers.add(code);
                    hasUsedModifierInCombo = false;
                    return;
                }
                
                hasUsedModifierInCombo = true;
                const hex = '0x' + code.toString(16).toLowerCase();
                let combination: string[] = [];
                
                if (activeVkModifiers.has(0x11) || activeVkModifiers.has(0xA2) || activeVkModifiers.has(0xA3)) combination.push('0xa2');
                if (activeVkModifiers.has(0x10) || activeVkModifiers.has(0xA0) || activeVkModifiers.has(0xA1)) combination.push('0xa0');
                if (activeVkModifiers.has(0x12) || activeVkModifiers.has(0xA4) || activeVkModifiers.has(0xA5)) combination.push('0xa4');
                if (activeVkModifiers.has(0x5B) || activeVkModifiers.has(0x5C)) combination.push('0x5b');
                
                if (!combination.includes(hex)) combination.push(hex);
                processKeyRecord(combination.join('+'));
            } else {
                if (isMod(code)) {
                    if (!hasUsedModifierInCombo) {
                        let hex = '0x' + code.toString(16).toLowerCase();
                        if ([0x10, 0xA0, 0xA1].includes(code)) hex = '0xa0';
                        if ([0x11, 0xA2, 0xA3].includes(code)) hex = '0xa2';
                        if ([0x12, 0xA4, 0xA5].includes(code)) hex = '0xa4';
                        if ([0x5B, 0x5C].includes(code)) hex = '0x5b';
                        processKeyRecord(hex);
                    }
                    activeVkModifiers.delete(code);
                }
            }
        });
    // 恢復雙引擎錄製 (Hybrid Mode 3.0)
    // 由於 WebView2 焦點中會導致底層 Hook 失效，我們在焦點中改由 DOM 錄製，防護則交給 RegisterHotKey
        window.addEventListener('keydown', (e) => {
            if (!recordingTargetId) return;
            
            // 徹底封鎖瀏覽器行為 (F5, Ctrl+R 等)
            e.preventDefault();
            e.stopPropagation();
            
            if (e.repeat) return;

            const code = e.keyCode;
            const isMod = (c: number) => [16, 17, 18, 91, 92].includes(c);
            
            if (isMod(code)) {
                hasUsedModifierInCombo = false;
                return;
            }

            hasUsedModifierInCombo = true;
            const hex = '0x' + code.toString(16).toLowerCase();
            let combination: string[] = [];
            if (e.ctrlKey) combination.push('0xa2');
            if (e.shiftKey) combination.push('0xa0');
            if (e.altKey) combination.push('0xa4');
            if (e.metaKey) combination.push('0x5b');
            if (!combination.includes(hex)) combination.push(hex);
            
            processKeyRecord(combination.join('+'));
        }, true);

        window.addEventListener('keyup', (e) => {
            if (!recordingTargetId) return;
            e.preventDefault();
            e.stopPropagation();

            const code = e.keyCode;
            const isMod = (c: number) => [16, 17, 18, 91, 92].includes(c);
            if (isMod(code) && !hasUsedModifierInCombo) {
                let hex = '0x' + code.toString(16).toLowerCase();
                if (code === 17) hex = '0xa2';
                if (code === 16) hex = '0xa0';
                if (code === 18) hex = '0xa4';
                if (code === 91 || code === 92) hex = '0x5b';
                processKeyRecord(hex);
            }
        }, true);
        
        // 防止錄製期間意外重新載入
        window.addEventListener('beforeunload', (e) => {
            if (recordingTargetId) {
                invoke('set_recording_mode', { enabled: false }); // 安全復原
                e.preventDefault();
                // @ts-ignore
                e.returnValue = ''; 
                return '';
            }
        });

        // 綁定各角落按鈕
        ['tl', 'tr', 'bl', 'br'].forEach(corner => {
            const btnBrowse = document.getElementById(`btn-browse-${corner}`);
            const btnRecord = document.getElementById(`btn-record-${corner}`);
            const inputVal = document.getElementById(`edit-${corner}-value`) as HTMLInputElement;
            const statusEl = document.getElementById(`status-record-${corner}`);

            if (btnBrowse && inputVal) {
                btnBrowse.addEventListener('click', async () => {
                    // 點擊瀏覽按鈕時，依要求直接清空舊內容
                    inputVal.value = "";
                    const selected = await open({
                        multiple: false,
                        filters: [{ name: 'Executable', extensions: ['exe', 'bat', 'cmd', 'lnk'] }]
                    });
                    if (selected && typeof selected === 'string') {
                        inputVal.value = selected;
                    }
                    inputVal.dispatchEvent(new Event('input'));
                    updatePreview();
                });
            }

            if (btnRecord && inputVal) {
                btnRecord.addEventListener('click', async () => {
                    if (recordingTargetId === inputVal.id) {
                        await invoke('set_recording_mode', { enabled: false });
                        inputVal.readOnly = false;
                        btnRecord.classList.remove('active-tool');
                        btnRecord.textContent = '⏺️';
                        if (statusEl) {
                            statusEl.style.display = 'none';
                            statusEl.textContent = '🔴 錄製中...';
                        }
                        
                        // 延後清空 ID 並觸發存檔
                        recordingTargetId = null;
                        emit('editor-save', {});
                        updatePreview();
                    } else {
                        if (recordingTargetId) {
                            const prevCorner = recordingTargetId.split('-')[1];
                            const prevBtn = document.getElementById(`btn-record-${prevCorner}`);
                            const prevInput = document.getElementById(`edit-${prevCorner}-value`) as HTMLInputElement;
                            const prevStatus = document.getElementById(`status-record-${prevCorner}`);
                            if (prevBtn) {
                                prevBtn.classList.remove('active-tool');
                                prevBtn.textContent = '⏺️';
                            }
                            if (prevInput) prevInput.readOnly = false;
                            if (prevStatus) prevStatus.style.display = 'none';
                        }
                        
                        // 強制視窗獲取焦點，確保 Rust Hook 能正確判定前景並攔截按鍵
                        await getCurrentWindow().setFocus();
                        
                        activeVkModifiers.clear();
                        recordingTargetId = inputVal.id;
                        await invoke('set_recording_mode', { enabled: true });
                        
                        inputVal.readOnly = true;
                        // 如果原本已經是巨集或按鍵碼，則不予清空，繼續追加
                        const oldVal = inputVal.value.trim().toLowerCase();
                        const isMacroOrKey = oldVal.includes(',') || oldVal.startsWith('0x') || oldVal === 'l' || oldVal.startsWith('w');
                        if (!isMacroOrKey) {
                            inputVal.value = '';
                        }
                        lastRecordTime = Date.now();
                        btnRecord.classList.add('active-tool');
                        btnRecord.textContent = '⏹️';
                        if (statusEl) statusEl.style.display = 'flex';
                        
                        btnRecord.blur();
                        inputVal.focus();
                    }
                });
            }

            // 監聽直接輸入模式切換，立即觸發存檔
            const chkDirect = document.getElementById(`chk-direct-${corner}`);
            chkDirect?.addEventListener('change', async () => {
                inputVal.dispatchEvent(new Event('input'));
                emit('editor-save', {});
                
                // 如果取消勾選「直接貼上」，則立即對現有內容進行格式校驗
                if (chkDirect instanceof HTMLInputElement && !chkDirect.checked) {
                    const names: Record<string, string> = { 'tl': '主/英 (TL)', 'tr': 'Shift (TR)', 'bl': 'Fn (BL)', 'br': '注音 (BR)' };
                    const isValid = await validateSingleInput(inputVal.value, names[corner], corner);
                    if (!isValid) {
                        // 如果校驗失敗，將焦點移回輸入框
                        setTimeout(() => inputVal.focus(), 10);
                    }
                }
            });
        });
    }

    let editorModifiers = { isShift: false, isFn: false, isCaps: false, isNum: false };
    let editorKeyCode = 0;
    let editorKeySpecial = false;

    const updatePreview = () => {
        const getVal = (id: string) => {
            const el = document.getElementById(id) as HTMLInputElement;
            return el ? el.value : "";
        };
        const preview = document.getElementById('key-preview');
        if (!preview) return;

        const bgColor = getVal('edit-bg-color');
        const tlDisp = getVal('edit-tl-display');
        const trDisp = getVal('edit-tr-display');
        const blDisp = getVal('edit-bl-display');
        const brDisp = getVal('edit-br-display');
        const tlColor = getVal('edit-tl-color');
        const trColor = getVal('edit-tr-color');
        const blColor = getVal('edit-bl-color');
        const brColor = getVal('edit-br-color');

        preview.style.backgroundColor = bgColor;
        
        const tl = preview.querySelector('.preview-tl') as HTMLElement;
        const tr = preview.querySelector('.preview-tr') as HTMLElement;
        const bl = preview.querySelector('.preview-bl') as HTMLElement;
        const br = preview.querySelector('.preview-br') as HTMLElement;
        const center = preview.querySelector('.preview-center') as HTMLElement;

        if (isDynamic) {
            tl.textContent = ""; tr.textContent = ""; bl.textContent = ""; br.textContent = "";
            center.textContent = getCenterLabel({ code: editorKeyCode, label: tlDisp, sub: trDisp, fn: blDisp, zhPinyin: brDisp, special: editorKeySpecial } as any, editorModifiers.isShift, editorModifiers.isFn, editorModifiers.isCaps, editorModifiers.isNum);
            center.style.color = tlColor;
        } else {
            center.textContent = "";
            tl.textContent = tlDisp; tl.style.color = tlColor;
            tr.textContent = trDisp; tr.style.color = trColor;
            bl.textContent = blDisp; bl.style.color = blColor;
            br.textContent = brDisp; br.style.color = brColor;
        }
    };

let isShowingError = false;

async function validateMacro(input: string, label: string): Promise<boolean> {
    if (isShowingError) return false;
    const parts = input.split(',').map(s => s.trim().toLowerCase());
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === 'l') {
            if (i !== parts.length - 1) {
                isShowingError = true;
                await message(`「${label}」巨集錯誤：\n\n無限循環指令 "l" 只能放置在最末端。`, { title: '格式錯誤', kind: 'error' });
                isShowingError = false;
                return false;
            }
        } else if (p.startsWith('w')) {
            const ms = p.substring(1);
            if (!/^\d+$/.test(ms)) {
                isShowingError = true;
                await message(`「${label}」巨集錯誤：\n\n等待指令 "${p}" 格式錯誤，應為 w 後接數字 (毫秒)。`, { title: '格式錯誤', kind: 'error' });
                isShowingError = false;
                return false;
            }
        } else if (p.startsWith('l')) {
            const n = p.substring(1);
            if (!/^\d+$/.test(n)) {
                isShowingError = true;
                await message(`「${label}」巨集錯誤：\n\n循環指令 "${p}" 格式錯誤，應為 l 後接數字 (次數)。`, { title: '格式錯誤', kind: 'error' });
                isShowingError = false;
                return false;
            }
        } else if (p.startsWith('0x')) {
            if (!/^0x[0-9a-fA-F]{1,4}$/.test(p)) {
                isShowingError = true;
                await message(`「${label}」巨集錯誤：\n\n按鍵碼 "${p}" 格式錯誤，應為 0x 後接 16 進位數字。`, { title: '格式錯誤', kind: 'error' });
                isShowingError = false;
                return false;
            }
        } else {
            // 無法識別的指令 (如 ,a)
            isShowingError = true;
            await message(`「${label}」巨集包含無效指令：「${p}」\n\n有效的巨集指令包括：\n- 按鍵碼 (如 0x1B)\n- 等待 (如 w500)\n- 循環 (如 l 或 l10)`, { title: '指令錯誤', kind: 'error' });
            isShowingError = false;
            return false;
        }
    }
    return true;
}

async function validateSingleInput(val: string, label: string, corner: string): Promise<boolean> {
    if (isShowingError) return false;
    val = val.trim();
    if (!val) return true;
    
    // 檢查該角落是否開啟了「直接輸入模式」
    const chkDirect = document.getElementById(`chk-direct-${corner}`) as HTMLInputElement;
    if (chkDirect && chkDirect.checked) {
        return true; // 跳過校驗
    }
    
    if (val.includes(',')) {
        return await validateMacro(val, label);
    }
    
    if (val.startsWith('0x')) {
        if (!/^0x[0-9a-fA-F]{1,4}$/.test(val)) {
            isShowingError = true;
            await message(`「${label}」格式錯誤：\n\n16 進位碼應為 0x 後接 1 到 4 位數 (如 0x1B)。`, { title: '格式錯誤', kind: 'error' });
            isShowingError = false;
            return false;
        }
        return true;
    }
    
    // 路徑特徵檢查：包含斜線、磁碟槽或特定副檔名
    const isPath = /^[a-zA-Z]:\\/.test(val) || val.includes('\\') || val.includes('/') || val.toLowerCase().endsWith('.exe') || val.toLowerCase().endsWith('.bat');
    if (isPath) return true;
    
    // 都不符合，視為無意義字串
    isShowingError = true;
    await message(`「${label}」內容無效：\n\n輸入值必須是 16 進位碼 (0xXX)、巨集 (以逗號分隔指令) 或執行檔路徑。\n\n無法識別您輸入的：「${val}」`, { title: '內容錯誤', kind: 'error' });
    isShowingError = false;
    return false;
}



    await listen('load-key', (e: any) => {
        const { key, isDark, isDynamic: dynamicMode, isFull: editorIsFull, isZhuyinMode: zhMode, modifiers } = e.payload;
        
        if (zhMode !== undefined) isZhuyinMode = zhMode;
        editorKeyCode = key.code || 0;
        editorKeySpecial = !!key.special;
        
        // 載入新按鍵時，還原各角落的直接輸入模式狀態
        ['tl', 'tr', 'bl', 'br'].forEach(c => {
            const chk = document.getElementById(`chk-direct-${c}`) as HTMLInputElement;
            if (chk) {
                const ov = (key as any)[`${c}_ov` as keyof KeyDefinition];
                chk.checked = !!(ov && ov.isDirect);
            }
        });
        
        if (modifiers) editorModifiers = modifiers;
        if (dynamicMode !== undefined) isDynamic = dynamicMode;
        applyTheme(isDark);
        
        const setVal = (id: string, val: string) => { (document.getElementById(id) as any).value = val; };
        const setLock = (id: string, isLocked: boolean) => {
            const el = document.getElementById(id) as any;
            if (el) {
                el.readOnly = isLocked;
                if (isLocked) {
                    el.style.backgroundColor = isDark ? '#334155' : '#f1f5f9';
                    el.style.color = isDark ? '#94a3b8' : '#94a3b8';
                } else {
                    el.style.backgroundColor = '';
                    el.style.color = '';
                }
            }
            // 鎖定時同步禁用對應的瀏覽與錄製按鈕
            if (id.includes('-value')) {
                const corner = id.split('-')[1]; // tl, tr, bl, br
                const btnBrowse = document.getElementById(`btn-browse-${corner}`) as HTMLButtonElement;
                const btnRecord = document.getElementById(`btn-record-${corner}`) as HTMLButtonElement;
                if (btnBrowse) {
                    btnBrowse.disabled = isLocked;
                    btnBrowse.style.opacity = isLocked ? '0.3' : '1';
                    btnBrowse.style.pointerEvents = isLocked ? 'none' : 'auto';
                }
                if (btnRecord) {
                    btnRecord.disabled = isLocked;
                    btnRecord.style.opacity = isLocked ? '0.3' : '1';
                    btnRecord.style.pointerEvents = isLocked ? 'none' : 'auto';
                }
            }
        };
        
        const defaultValTl = getDefaultKeyValue(key, 'tl');
        const defaultValTr = getDefaultKeyValue(key, 'tr');
        const defaultValBl = getDefaultKeyValue(key, 'bl');
        
        setVal('edit-tl-display', key.tl_ov?.display || key.label || "");
        setVal('edit-tl-value', key.tl_ov?.value || defaultValTl);
        const isTlLocked = defaultValTl !== "" && defaultValTl !== "0x0";
        setLock('edit-tl-value', isTlLocked);
        setLock('edit-tl-display', isTlLocked);
        
        setVal('edit-tr-display', key.tr_ov?.display || key.sub || "");
        setVal('edit-tr-value', key.tr_ov?.value || defaultValTr);
        const isTrLocked = defaultValTr !== "";
        setLock('edit-tr-value', isTrLocked);
        setLock('edit-tr-display', isTrLocked);
        
        setVal('edit-bl-display', key.bl_ov?.display || key.fn || "");
        setVal('edit-bl-value', key.bl_ov?.value || defaultValBl);
        
        if (editorIsFull) {
            setLock('edit-bl-display', true);
            setLock('edit-bl-value', true);
            setVal('edit-bl-display', "");
            setVal('edit-bl-value', "");
        } else {
            const isBlLocked = defaultValBl !== "";
            setLock('edit-bl-display', isBlLocked);
            setLock('edit-bl-value', isBlLocked);
        }
        
        setVal('edit-br-display', key.br_ov?.display || key.zhPinyin || "");
        setVal('edit-br-value', key.br_ov?.value || "");
        setLock('edit-br-display', false);
        setLock('edit-br-value', false);

        // 初始化所有 textarea 高度
        ['tl', 'tr', 'bl', 'br'].forEach(corner => {
            const ta = document.getElementById(`edit-${corner}-value`) as HTMLTextAreaElement;
            if (ta) syncTextareaHeight(ta);
        });

        // 切換鍵防呆：鎖定其對應的角落，防止使用者覆蓋設定導致切換後無法切回
        if (key.code === 0xA0 || key.code === 0xA1 || key.code === 0x14) { // Shift, Caps Lock -> TR
            setLock('edit-tr-display', true);
            setLock('edit-tr-value', true);
        }
        if (key.code === 0xFE) { // Fn -> BL
            setLock('edit-bl-display', true);
            setLock('edit-bl-value', true);
        }
        if (key.code === 0x5D) { // 中英切換 (En/ㄅ) -> BR
            setLock('edit-br-display', true);
            setLock('edit-br-value', true);
        }

        const defaultBg = isDark ? '#1e293b' : '#ffffff';
        const defaultTl = isDark ? '#f8fafc' : '#0f172a';
        const defaultTr = isDark ? '#38bdf8' : '#0369a1';
        const defaultBl = isDark ? '#4ade80' : '#15803d';
        const defaultBr = isDark ? '#fbbf24' : '#b45309';

        setVal('edit-tl-color', key.tlColor || defaultTl);
        setVal('edit-tr-color', key.trColor || defaultTr);
        setVal('edit-bl-color', key.blColor || defaultBl);
        setVal('edit-br-color', key.brColor || defaultBr);
        setVal('edit-bg-color', key.bgColor || defaultBg);
        setVal('edit-border-color', key.borderColor || (isDark ? '#475569' : '#e2e8f0'));

        updatePreview();
    });

    const editorInputs = [
        'edit-tl-display', 'edit-tl-value', 'edit-tl-color',
        'edit-tr-display', 'edit-tr-value', 'edit-tr-color',
        'edit-bl-display', 'edit-bl-value', 'edit-bl-color',
        'edit-br-display', 'edit-br-value', 'edit-br-color',
        'edit-bg-color', 'edit-border-color'
    ];

    editorInputs.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            const getVal = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
            
            const defaultBg = isDark ? '#1e293b' : '#ffffff';
            const defaultBorder = isDark ? '#475569' : '#e2e8f0';
            
            let newBg: string | null = getVal('edit-bg-color');
            if (newBg === defaultBg) newBg = null;
            
            let newBorder: string | null = getVal('edit-border-color');
            if (newBorder === defaultBorder) newBorder = null;

            const data = {
                tl_ov: { 
                    display: getVal('edit-tl-display'), 
                    value: getVal('edit-tl-value'),
                    isDirect: (document.getElementById('chk-direct-tl') as HTMLInputElement).checked
                },
                tr_ov: { 
                    display: getVal('edit-tr-display'), 
                    value: getVal('edit-tr-value'),
                    isDirect: (document.getElementById('chk-direct-tr') as HTMLInputElement).checked
                },
                bl_ov: { 
                    display: getVal('edit-bl-display'), 
                    value: getVal('edit-bl-value'),
                    isDirect: (document.getElementById('chk-direct-bl') as HTMLInputElement).checked
                },
                br_ov: { 
                    display: getVal('edit-br-display'), 
                    value: getVal('edit-br-value'),
                    isDirect: (document.getElementById('chk-direct-br') as HTMLInputElement).checked
                },
                tlColor: getVal('edit-tl-color'),
                trColor: getVal('edit-tr-color'),
                blColor: getVal('edit-bl-color'),
                brColor: getVal('edit-br-color'),
                bgColor: newBg,
                borderColor: newBorder
            };
            emit('editor-update', data);


            if (id.endsWith('-value')) {
                const val = getVal(id);
                if (val.includes(',')) {
                    // 即時驗證僅作提示，不阻止輸入
                }
            }

            if (id.endsWith('-value') && el instanceof HTMLTextAreaElement) {
                syncTextareaHeight(el);
            }

            updatePreview();
        });

        el.addEventListener('blur', async (e: any) => {
            if (isShowingError) return;
            const corner = id.split('-')[1];
            const related = e.relatedTarget as HTMLElement;
            
            // 如果點擊的是同一區的功能按鈕 (瀏覽、錄製或直接輸入勾選)，則略過校驗，由按鈕的 click/change 事件統一決定是否清空或保留
            if (related && (related.id === `btn-browse-${corner}` || related.id === `btn-record-${corner}` || related.id === `chk-direct-${corner}`)) {
                return;
            }

            const val = (el as HTMLInputElement).value;
            const names: Record<string, string> = { 'tl': '主/英 (TL)', 'tr': 'Shift (TR)', 'bl': 'Fn (BL)', 'br': '注音 (BR)' };
            
            // 僅針對「值 (value)」欄位進行校驗，標籤 (display) 不用校驗
            if (id.endsWith('-value')) {
                const isValid = await validateSingleInput(val, names[corner], corner);
                if (isValid) {
                    emit('editor-save', {});
                } else {
                    // 有錯誤時，強制將焦點移回輸入框直到修正
                    setTimeout(() => (el as HTMLElement).focus(), 10);
                }
            } else {
                // 標籤欄位直接存檔
                emit('editor-save', {});
            }
        });
    });

    const setupApplyCorner = (btnId: string, colorInputId: string, prop: string, _name: string) => {
        document.getElementById(btnId)?.addEventListener('click', () => {
            const color = (document.getElementById(colorInputId) as HTMLInputElement).value;
            emit('editor-apply-all', { prop, color });
        });
    };
    setupApplyCorner('btn-apply-tl-all', 'edit-tl-color', 'tlColor', '主鍵 (TL)');
    setupApplyCorner('btn-apply-tr-all', 'edit-tr-color', 'trColor', '上排 (TR)');
    setupApplyCorner('btn-apply-bl-all', 'edit-bl-color', 'blColor', '下排 (BL)');
    setupApplyCorner('btn-apply-br-all', 'edit-br-color', 'brColor', '注音 (BR)');

    document.getElementById('btn-apply-bg-border-all')?.addEventListener('click', () => {
        const defaultBg = isDark ? '#1e293b' : '#ffffff';
        const defaultBorder = isDark ? '#475569' : '#e2e8f0';

        let bgColor: string | null = (document.getElementById('edit-bg-color') as HTMLInputElement).value;
        if (bgColor === defaultBg) bgColor = null;

        let borderColor: string | null = (document.getElementById('edit-border-color') as HTMLInputElement).value;
        if (borderColor === defaultBorder) borderColor = null;

        emit('editor-apply-all', { 
            updates: [
                { prop: 'bgColor', color: bgColor },
                { prop: 'borderColor', color: borderColor }
            ]
        });
    });

    document.getElementById('btn-close-modal')?.addEventListener('click', async () => {
        const win = getCurrentWindow();
        // 觸發視窗關閉流程 (這會進入下方的 onCloseRequested 監聽器)
        await win.close();
    });

    // 攔截視窗關閉請求 (包含系統標題列的 X 按鈕與手動呼叫的 win.close())
    const win = getCurrentWindow();
    win.onCloseRequested(async (_event) => {
        // 直接通知主視窗編輯器已關閉
        await emit('editor-closed', {});
        // 不再攔截 (不再呼叫 preventDefault)，視窗將直接關閉
    });
    
    // 要求主視窗傳送按鍵資料
    await emit('request-key');
    setupTooltips();
}
