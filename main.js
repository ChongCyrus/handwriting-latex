const { Plugin, Modal, Notice, PluginSettingTab, Setting, requestUrl } = require('obsidian');


const DEFAULT_SETTINGS = {
  apiProvider: "simpletex",
  apiKey: "",
  apiEndpoint: "",
  customPrompt: "Recognize the handwritten mathematical formula in this image and return ONLY the LaTeX code, without any explanation or markdown formatting.",
  mathMode: "inline",
  strokeColor: "#000000",
  strokeWidth: 3,
  canvasWidth: 1200,
  canvasHeight: 600,
  showGrid: true,
  customResponseField: "text",
  customApiKeyHeader: "X-API-Key",
  customImageFieldName: "image",
  mathpixAppId: "",
  openaiModel: "gpt-4o",
  openaiDetail: "high",
  maxHistorySize: 30,
  customProviders: [],
  customFormFields: [],
  customPlaceholders: []
};

const PRESET_TEMPLATES = [
  {
    name: "OpenAI GPT-4o (Custom)",
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    headers: [
      { key: "Authorization", value: "Bearer {{apiKey}}" },
      { key: "Content-Type", value: "application/json" }
    ],
    bodyType: "json",
    bodyTemplate: JSON.stringify({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "{{prompt}}" },
          { type: "image_url", image_url: { url: "{{image}}", detail: "high" } }
        ]
      }],
      max_tokens: 2048
    }, null, 2),
    responsePath: "choices.0.message.content",
    responseType: "json"
  },
  {
    name: "OpenAI o1/o3/o4 (Custom)",
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    headers: [
      { key: "Authorization", value: "Bearer {{apiKey}}" },
      { key: "Content-Type", value: "application/json" }
    ],
    bodyType: "json",
    bodyTemplate: JSON.stringify({
      model: "o3",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "{{prompt}}" },
          { type: "image_url", image_url: { url: "{{image}}", detail: "high" } }
        ]
      }],
      max_completion_tokens: 2048
    }, null, 2),
    responsePath: "choices.0.message.content",
    responseType: "json"
  },
  {
    name: "Anthropic Claude (Custom)",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: [
      { key: "x-api-key", value: "{{apiKey}}" },
      { key: "Content-Type", value: "application/json" },
      { key: "anthropic-version", value: "2023-06-01" }
    ],
    bodyType: "json",
    bodyTemplate: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "{{prompt}}" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "{{image_base64}}" } }
        ]
      }]
    }, null, 2),
    responsePath: "content.0.text",
    responseType: "json"
  },
  {
    name: "Google Gemini (Custom)",
    method: "POST",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={{apiKey}}",
    headers: [
      { key: "Content-Type", value: "application/json" }
    ],
    bodyType: "json",
    bodyTemplate: JSON.stringify({
      contents: [{
        parts: [
          { text: "{{prompt}}" },
          { inline_data: { mime_type: "image/png", data: "{{image_base64}}" } }
        ]
      }]
    }, null, 2),
    responsePath: "candidates.0.content.parts.0.text",
    responseType: "json"
  },
  {
    name: "SimpleTex-style (Custom Form)",
    method: "POST",
    url: "https://server.simpletex.cn/api/latex_ocr",
    headers: [
      { key: "token", value: "{{apiKey}}" }
    ],
    bodyType: "form-data",
    formFieldName: "file",
    responsePath: "res.latex",
    responseType: "json"
  }
];

class HandwritingLatexPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.history = [];
    this.historyIndex = -1;

    this.addCommand({
      id: "open-handwriting-canvas",
      name: "Open handwriting canvas",
      editorCallback: (editor) => {
        new HandwritingModal(this.app, this, this.settings, editor).open();
      },
    });

    this.addRibbonIcon("pencil", "Handwriting to LaTeX", () => {
      const activeView = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
      if (activeView) {
        new HandwritingModal(this.app, this, this.settings, activeView.editor).open();
      } else {
        new Notice("Please open a markdown file first");
      }
    });

    this.addSettingTab(new HandwritingSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class HandwritingModal extends Modal {
  constructor(app, plugin, settings, editor) {
    super(app);
    this.plugin = plugin;
    this.settings = settings;
    this.editor = editor;
    this.isDrawing = false;
    this.strokes = [];
    this.currentStroke = [];
    this.resizeStart = null;
    this.wrapperStart = null;
    this.isFullscreen = false;
    this.savedWrapperStyles = null;
    this.expandThreshold = 50;
    this.expandDelta = 200;

    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1.0;
    this.minScale = 0.15;
    this.maxScale = 5.0;

    this.mode = 'pen';
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.panStartOffset = { x: 0, y: 0 };

    this.pinchState = null;
    this.showGrid = settings.showGrid !== false;
    this.mathMode = settings.mathMode || "inline";

    // 相机相关
    this.currentStream = null;
    this.currentFacingMode = "environment";

    // 裁剪器相关
    this.cropperImageScale = 1;
    this.cropperImageOffsetX = 0;
    this.cropperImageOffsetY = 0;
    this.cropperSelectionData = null;
    this.toolbarCollapsed = false;
    this.savedToolbarParent = null;
    this.savedToolbarNextSibling = null;

    // 结果面板
    this.resultExpanded = false;
    this.resultUserHeight = null;
    this.resultDragMoved = false;
  }

  onOpen() {
    const contentEl = this.contentEl;
    contentEl.empty();
    contentEl.addClass("handwriting-modal");
    contentEl.addClass("handwriting-modal-fullscreen");

    // ==================== 顶部精简标题栏 ====================
    const header = contentEl.createDiv({ cls: "handwriting-header" });
    this.header = header;

    const headerLeft = header.createDiv({ cls: "header-left" });
    headerLeft.createEl("h2", { text: "✍️ Handwriting" });

    const mediaActions = headerLeft.createDiv({ cls: "header-media-actions" });
    const cameraBtn = mediaActions.createEl("button", { text: "📷", cls: "header-icon-btn", attr: { "aria-label": "Camera" } });
    cameraBtn.addEventListener("click", () => this.openCamera());
    const albumBtn = mediaActions.createEl("button", { text: "🖼️", cls: "header-icon-btn", attr: { "aria-label": "Album" } });
    albumBtn.addEventListener("click", () => this.openAlbum());

    const headerActions = header.createDiv({ cls: "header-actions" });
    const recognizeBtn = headerActions.createEl("button", { text: "🔍 Recognize", cls: "mod-cta header-action-btn" });
    recognizeBtn.addEventListener("click", () => this.recognizeFormula());
    const insertBtn = headerActions.createEl("button", { text: "✅ Insert", cls: "mod-cta header-action-btn" });
    insertBtn.addEventListener("click", () => this.insertAndClose());

    // ==================== 主体区域 ====================
    const body = contentEl.createDiv({ cls: "handwriting-body" });
    this.body = body;

    // 画布区域
    const canvasArea = body.createDiv({ cls: "canvas-area" });

    const canvasWrapper = canvasArea.createDiv({ cls: "canvas-wrapper" });
    // Desktop: make canvas wrapper wider by computing available space
    const desktopWidth = window.innerWidth > 768
      ? Math.min(Math.max(800, (window.innerWidth - 420)), this.settings.canvasWidth)
      : this.settings.canvasWidth;
    canvasWrapper.style.width = desktopWidth + "px";
    canvasWrapper.style.height = this.settings.canvasHeight + "px";
    canvasWrapper.style.overflow = "hidden";
    canvasWrapper.style.position = "relative";

    this.canvas = canvasWrapper.createEl("canvas");
    this.canvas.width = this.settings.canvasWidth;
    this.canvas.height = this.settings.canvasHeight;
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.canvas.style.cursor = "crosshair";
    this.canvas.style.touchAction = "none";

    this.ctx = this.canvas.getContext("2d");
    this.setupContext(this.ctx);
    this.clearBackground(this.ctx, this.canvas.width, this.canvas.height);

    const resizeHandle = canvasWrapper.createDiv({ cls: "resize-handle" });
    resizeHandle.setAttribute("title", "Drag to resize view");
    this.bindResizeEvents(resizeHandle, canvasWrapper);

    this.bindCanvasEvents(this.canvas);

    // 侧边可隐藏工具栏
    const toolbarContainer = canvasArea.createDiv({ cls: "toolbar-container" });
    const floatToolbar = toolbarContainer.createDiv({ cls: "floating-toolbar" });

    const toggleBtn = toolbarContainer.createEl("button", {
      text: "◀",
      cls: "toolbar-toggle-btn",
      attr: { "aria-label": "Collapse toolbar" }
    });
    toggleBtn.addEventListener("click", () => this.toggleToolbar());

    const modeGroup = floatToolbar.createDiv({ cls: "toolbar-group" });
    this.penBtn = modeGroup.createEl("button", { text: "✏️", cls: "toolbar-btn active", attr: { "aria-label": "Pen" } });
    this.penBtn.addEventListener("click", () => this.setMode('pen'));
    this.eraserBtn = modeGroup.createEl("button", { text: "🧹", cls: "toolbar-btn", attr: { "aria-label": "Eraser" } });
    this.eraserBtn.addEventListener("click", () => this.setMode('eraser'));
    this.handBtn = modeGroup.createEl("button", { text: "✋", cls: "toolbar-btn", attr: { "aria-label": "Pan" } });
    this.handBtn.addEventListener("click", () => this.setMode('hand'));

    const actionGroup = floatToolbar.createDiv({ cls: "toolbar-group" });
    const undoBtn = actionGroup.createEl("button", { text: "↩️", cls: "toolbar-btn", attr: { "aria-label": "Undo" } });
    undoBtn.addEventListener("click", () => this.undoLastStroke());
    const clearBtn = actionGroup.createEl("button", { text: "🗑️", cls: "toolbar-btn", attr: { "aria-label": "Clear" } });
    clearBtn.addEventListener("click", () => this.clearCanvas());
    const rotateLeftBtn = actionGroup.createEl("button", { text: "↺", cls: "toolbar-btn", attr: { "aria-label": "Rotate left" } });
    rotateLeftBtn.addEventListener("click", () => this.rotateCanvas(false));
    const rotateRightBtn = actionGroup.createEl("button", { text: "↻", cls: "toolbar-btn", attr: { "aria-label": "Rotate right" } });
    rotateRightBtn.addEventListener("click", () => this.rotateCanvas(true));

    const viewGroup = floatToolbar.createDiv({ cls: "toolbar-group" });
    const zoomOutBtn = viewGroup.createEl("button", { text: "➖", cls: "toolbar-btn", attr: { "aria-label": "Zoom out" } });
    zoomOutBtn.addEventListener("click", () => this.zoomBy(0.8));
    const zoomInBtn = viewGroup.createEl("button", { text: "➕", cls: "toolbar-btn", attr: { "aria-label": "Zoom in" } });
    zoomInBtn.addEventListener("click", () => this.zoomBy(1.25));
    const fitBtn = viewGroup.createEl("button", { text: "⊘", cls: "toolbar-btn", attr: { "aria-label": "Fit view" } });
    fitBtn.addEventListener("click", () => this.fitViewToStrokes());
    const resetBtn = viewGroup.createEl("button", { text: "🏠", cls: "toolbar-btn", attr: { "aria-label": "Reset view" } });
    resetBtn.addEventListener("click", () => this.resetView());
    const gridBtn = viewGroup.createEl("button", { text: "⊞", cls: "toolbar-btn" + (this.showGrid ? " active" : ""), attr: { "aria-label": "Toggle grid" } });
    gridBtn.addEventListener("click", () => {
      this.showGrid = !this.showGrid;
      gridBtn.toggleClass("active", this.showGrid);
      this.redrawCanvas();
    });
    // 全屏按钮
    const fullscreenBtn = viewGroup.createEl("button", { text: "⛶", cls: "toolbar-btn", attr: { "aria-label": "Fullscreen" } });
    fullscreenBtn.addEventListener("click", () => this.toggleFullscreen());

    // ==================== 可折叠结果面板 ====================
    const resultPanel = body.createDiv({ cls: "result-panel" });
    const resultHandle = resultPanel.createDiv({ cls: "result-handle" });
    resultHandle.innerHTML = `<span class="handle-bar"></span><span class="handle-label">LaTeX Result</span>`;

    const resultContent = resultPanel.createDiv({ cls: "result-content" });
    this.statusEl = resultContent.createDiv({ cls: "status-text" });
    this.statusEl.setText("Draw a formula and tap 'Recognize'");

    const mathModeRow = resultContent.createDiv({ cls: "math-mode-row" });
    mathModeRow.createEl("span", { text: "Insert as: ", cls: "math-mode-label" });

    this.inlineMathBtn = mathModeRow.createEl("button", {
      text: "Inline ($)",
      cls: "math-mode-btn" + (this.mathMode === "inline" ? " active" : "")
    });
    this.displayMathBtn = mathModeRow.createEl("button", {
      text: "Display ($$)",
      cls: "math-mode-btn" + (this.mathMode === "display" ? " active" : "")
    });
    this.rawMathBtn = mathModeRow.createEl("button", {
      text: "Raw (no $)",
      cls: "math-mode-btn" + (this.mathMode === "raw" ? " active" : "")
    });

    const setMathMode = (mode) => {
      this.mathMode = mode;
      this.inlineMathBtn.toggleClass("active", mode === "inline");
      this.displayMathBtn.toggleClass("active", mode === "display");
      this.rawMathBtn.toggleClass("active", mode === "raw");
      const labels = {
        inline: "Insert mode: Inline math",
        display: "Insert mode: Display math",
        raw: "Insert mode: Raw LaTeX (no $)"
      };
      this.statusEl.setText(labels[mode]);
    };

    this.inlineMathBtn.addEventListener("click", () => setMathMode("inline"));
    this.displayMathBtn.addEventListener("click", () => setMathMode("display"));
    this.rawMathBtn.addEventListener("click", () => setMathMode("raw"));

    // 历史记录导航
    const historyRow = resultContent.createDiv({ cls: "history-row" });
    this.prevHistoryBtn = historyRow.createEl("button", {
      text: "←",
      cls: "history-nav-btn disabled",
      attr: { "aria-label": "Previous result" }
    });
    this.prevHistoryBtn.addEventListener("click", () => this.navigateHistory(-1));

    this.historyCounter = historyRow.createEl("span", {
      text: "0/0",
      cls: "history-counter"
    });

    this.nextHistoryBtn = historyRow.createEl("button", {
      text: "→",
      cls: "history-nav-btn disabled",
      attr: { "aria-label": "Next result" }
    });
    this.nextHistoryBtn.addEventListener("click", () => this.navigateHistory(1));

    resultContent.createEl("h3", { text: "Preview:" });
    this.resultEl = resultContent.createDiv({ cls: "latex-preview" });
    this.resultEl.setText("(No result yet)");

    this.resultExpanded = false;
    resultHandle.addEventListener("click", () => {
      if (resultHandle.hasAttribute("data-dragged")) {
        resultHandle.removeAttribute("data-dragged");
        return;
      }
      this.toggleResultPanel();
    });

    this.bindResultPanelDrag(resultHandle, resultPanel);

    // 底部提示
    const footer = contentEl.createDiv({ cls: "handwriting-footer" });
    footer.innerHTML = `
      <span>🖊️ Single finger: draw</span>
      <span>✋ Two fingers: pan & zoom</span>
      <span>🏠 Button: reset view</span>
    `;

    // ==================== 相册导入 ====================
    this.albumInput = contentEl.createEl("input", {
      type: "file",
      attr: { accept: "image/*", style: "display:none;" }
    });
    this.albumInput.addEventListener("change", (e) => this.handleFileSelect(e));

    // ==================== 原生相机覆盖层 ====================
    this.cameraOverlay = contentEl.createDiv({ cls: "camera-overlay" });
    this.cameraOverlay.style.display = "none";

    const cameraHeader = this.cameraOverlay.createDiv({ cls: "camera-header" });
    cameraHeader.createEl("h3", { text: "📷 Take Photo" });
    const cameraActions = cameraHeader.createDiv({ cls: "camera-actions" });
    const switchBtn = cameraActions.createEl("button", { text: "🔄", cls: "camera-icon-btn", attr: { "aria-label": "Switch camera" } });
    switchBtn.addEventListener("click", () => this.switchCamera());
    const closeCameraBtn = cameraActions.createEl("button", { text: "✕", cls: "camera-icon-btn", attr: { "aria-label": "Close" } });
    closeCameraBtn.addEventListener("click", () => this.closeCamera());

    const cameraBody = this.cameraOverlay.createDiv({ cls: "camera-body" });
    this.videoEl = cameraBody.createEl("video", { cls: "camera-video" });
    this.videoEl.setAttribute("autoplay", "");
    this.videoEl.setAttribute("playsinline", "");

    const cameraFooter = this.cameraOverlay.createDiv({ cls: "camera-footer" });
    const captureBtn = cameraFooter.createEl("button", { text: "⚪", cls: "camera-capture-btn", attr: { "aria-label": "Capture" } });
    captureBtn.addEventListener("click", () => this.capturePhoto());

    // ==================== 图片裁剪覆盖层 ====================
    this.cropperOverlay = contentEl.createDiv({ cls: "cropper-overlay" });
    this.cropperOverlay.style.display = "none";

    const cropperHeader = this.cropperOverlay.createDiv({ cls: "cropper-header" });
    cropperHeader.createEl("h3", { text: "✂️ Crop Formula" });
    const cropperActions = cropperHeader.createDiv({ cls: "cropper-actions" });
    const cropperSelectAll = cropperActions.createEl("button", { text: "Select All", cls: "cropper-action-btn" });
    cropperSelectAll.addEventListener("click", () => this.selectAllCropper());
    const cropperClear = cropperActions.createEl("button", { text: "Clear", cls: "cropper-action-btn mod-warning" });
    cropperClear.addEventListener("click", () => this.clearCropperSelection());
    const cropperCancel = cropperActions.createEl("button", { text: "Cancel", cls: "cropper-action-btn mod-warning" });
    cropperCancel.addEventListener("click", () => this.hideCropper());
    const cropperRecognize = cropperActions.createEl("button", { text: "🔍 Recognize", cls: "cropper-action-btn mod-cta" });
    cropperRecognize.addEventListener("click", () => this.confirmCropAndRecognize());

    const cropperBody = this.cropperOverlay.createDiv({ cls: "cropper-body" });
    this.cropperWrapper = cropperBody.createDiv({ cls: "cropper-wrapper" });
    this.cropperImage = this.cropperWrapper.createEl("img", { cls: "cropper-image" });

    // 暗色遮罩（4个div覆盖未选中区域）
    this.cropperMaskTop = this.cropperWrapper.createDiv({ cls: "cropper-mask cropper-mask-top" });
    this.cropperMaskBottom = this.cropperWrapper.createDiv({ cls: "cropper-mask cropper-mask-bottom" });
    this.cropperMaskLeft = this.cropperWrapper.createDiv({ cls: "cropper-mask cropper-mask-left" });
    this.cropperMaskRight = this.cropperWrapper.createDiv({ cls: "cropper-mask cropper-mask-right" });

    this.cropperSelection = this.cropperWrapper.createDiv({ cls: "cropper-selection" });
    this.cropperSelection.style.display = "none";

    // 8个调整手柄
    const handleNames = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
    for (const h of handleNames) {
      this.cropperSelection.createDiv({ cls: `cropper-handle cropper-handle-${h}`, attr: { 'data-handle': h } });
    }

    const cropperFooter = this.cropperOverlay.createDiv({ cls: "cropper-footer" });
    this.cropperInfoEl = cropperFooter.createEl("span", { cls: "cropper-info" });
    const cropperHint = cropperFooter.createEl("span", { cls: "cropper-hint" });
    cropperHint.textContent = "👆 Drag to select • 🤏 Pinch to zoom • ✋ Two fingers to pan";

    this.bindCropperEvents();

    this.updateModeUI();
    this.updateHistoryUI();

    // 工具栏高度自适应：初始化 + ResizeObserver
    this.syncToolbarHeight();
    this._toolbarResizeObserver = new ResizeObserver(() => {
      this.syncToolbarHeight();
    });
    const canvasWrapperEl = this.canvas?.parentElement;
    if (canvasWrapperEl) {
      this._toolbarResizeObserver.observe(canvasWrapperEl);
    }
  }

  // ==================== 裁剪器视图控制 ====================
  initCropperView() {
    const wrapper = this.cropperWrapper;
    const img = this.cropperImage;
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;

    if (!imgW || !imgH) {
      requestAnimationFrame(() => this.initCropperView());
      return;
    }

    img.style.width = imgW + "px";
    img.style.height = imgH + "px";

    const wrapW = wrapper.clientWidth;
    const wrapH = wrapper.clientHeight;

    if (!wrapW || !wrapH) {
      requestAnimationFrame(() => this.initCropperView());
      return;
    }

    const scaleX = wrapW / imgW;
    const scaleY = wrapH / imgH;
    this.cropperImageScale = Math.min(scaleX, scaleY, 1);

    const displayW = imgW * this.cropperImageScale;
    const displayH = imgH * this.cropperImageScale;

    this.cropperImageOffsetX = (wrapW - displayW) / 2;
    this.cropperImageOffsetY = (wrapH - displayH) / 2;

    this.applyCropperTransform();
  }

  applyCropperTransform() {
    this.cropperImage.style.transform = `translate(${this.cropperImageOffsetX}px, ${this.cropperImageOffsetY}px) scale(${this.cropperImageScale})`;
    this.cropperImage.style.transformOrigin = "0 0";
    this.updateSelectionDisplay();
    this.updateCropperMask();
  }

  screenToImagePixel(screenX, screenY) {
    const rect = this.cropperWrapper.getBoundingClientRect();
    const x = screenX - rect.left;
    const y = screenY - rect.top;
    return {
      x: (x - this.cropperImageOffsetX) / this.cropperImageScale,
      y: (y - this.cropperImageOffsetY) / this.cropperImageScale
    };
  }

  imagePixelToScreen(imgX, imgY) {
    return {
      x: imgX * this.cropperImageScale + this.cropperImageOffsetX,
      y: imgY * this.cropperImageScale + this.cropperImageOffsetY
    };
  }

  updateSelectionDisplay() {
    if (!this.cropperSelectionData) {
      this.cropperSelection.style.display = "none";
      return;
    }

    const { x, y, width, height } = this.cropperSelectionData;
    const topLeft = this.imagePixelToScreen(x, y);
    const bottomRight = this.imagePixelToScreen(x + width, y + height);

    this.cropperSelection.style.left = topLeft.x + "px";
    this.cropperSelection.style.top = topLeft.y + "px";
    this.cropperSelection.style.width = Math.max(0, bottomRight.x - topLeft.x) + "px";
    this.cropperSelection.style.height = Math.max(0, bottomRight.y - topLeft.y) + "px";
    this.cropperSelection.style.display = "block";

    if (this.cropperInfoEl) {
      this.cropperInfoEl.textContent = `${Math.round(width)}×${Math.round(height)} px`;
    }
  }

  updateCropperMask() {
    const wrapper = this.cropperWrapper;
    const wrapW = wrapper.clientWidth;
    const wrapH = wrapper.clientHeight;

    if (!wrapW || !wrapH) return;

    if (!this.cropperSelectionData || this.cropperSelection.style.display === "none") {
      this.cropperMaskTop.style.display = "block";
      this.cropperMaskTop.style.left = "0px"; this.cropperMaskTop.style.top = "0px";
      this.cropperMaskTop.style.width = wrapW + "px"; this.cropperMaskTop.style.height = wrapH + "px";
      this.cropperMaskBottom.style.display = "none";
      this.cropperMaskLeft.style.display = "none";
      this.cropperMaskRight.style.display = "none";
      return;
    }

    const sel = this.cropperSelectionData;
    const tl = this.imagePixelToScreen(sel.x, sel.y);
    const br = this.imagePixelToScreen(sel.x + sel.width, sel.y + sel.height);

    const left = Math.max(0, tl.x);
    const top = Math.max(0, tl.y);
    const right = Math.min(wrapW, br.x);
    const bottom = Math.min(wrapH, br.y);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    if (width <= 0 || height <= 0) {
      this.cropperMaskTop.style.display = "block";
      this.cropperMaskTop.style.left = "0px"; this.cropperMaskTop.style.top = "0px";
      this.cropperMaskTop.style.width = wrapW + "px"; this.cropperMaskTop.style.height = wrapH + "px";
      this.cropperMaskBottom.style.display = "none";
      this.cropperMaskLeft.style.display = "none";
      this.cropperMaskRight.style.display = "none";
      return;
    }

    this.cropperMaskTop.style.display = "block";
    this.cropperMaskTop.style.left = "0px"; this.cropperMaskTop.style.top = "0px";
    this.cropperMaskTop.style.width = wrapW + "px"; this.cropperMaskTop.style.height = top + "px";

    this.cropperMaskBottom.style.display = "block";
    this.cropperMaskBottom.style.left = "0px"; this.cropperMaskBottom.style.top = bottom + "px";
    this.cropperMaskBottom.style.width = wrapW + "px"; this.cropperMaskBottom.style.height = (wrapH - bottom) + "px";

    this.cropperMaskLeft.style.display = "block";
    this.cropperMaskLeft.style.left = "0px"; this.cropperMaskLeft.style.top = top + "px";
    this.cropperMaskLeft.style.width = left + "px"; this.cropperMaskLeft.style.height = height + "px";

    this.cropperMaskRight.style.display = "block";
    this.cropperMaskRight.style.left = right + "px"; this.cropperMaskRight.style.top = top + "px";
    this.cropperMaskRight.style.width = (wrapW - right) + "px"; this.cropperMaskRight.style.height = height + "px";
  }

  selectAllCropper() {
    if (!this.cropperImage.naturalWidth) return;
    this.cropperSelectionData = {
      x: 0,
      y: 0,
      width: this.cropperImage.naturalWidth,
      height: this.cropperImage.naturalHeight
    };
    this.updateSelectionDisplay();
    this.updateCropperMask();
  }

  clearCropperSelection() {
    this.cropperSelectionData = null;
    this.cropperSelection.style.display = "none";
    this.updateCropperMask();
    if (this.cropperInfoEl) this.cropperInfoEl.textContent = "";
  }

  // ==================== 相机逻辑 ====================
  async openCamera() {
    try {
      this.currentFacingMode = "environment";
      await this.startCamera();
      this.body.style.display = "none";
      this.header.style.display = "none";
      const footer = this.contentEl.querySelector(".handwriting-footer");
      if (footer) footer.style.display = "none";
      this.cameraOverlay.style.display = "flex";
      this.statusEl.setText("Camera active");
    } catch (err) {
      new Notice("Camera error: " + err.message);
      console.error(err);
    }
  }

  async startCamera() {
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(t => t.stop());
    }
    const constraints = {
      video: {
        facingMode: this.currentFacingMode || "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };
    this.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.videoEl.srcObject = this.currentStream;
    await this.videoEl.play();
  }

  switchCamera() {
    this.currentFacingMode = this.currentFacingMode === "environment" ? "user" : "environment";
    this.startCamera();
  }

  capturePhoto() {
    if (!this.videoEl.videoWidth) {
      new Notice("Camera not ready yet");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = this.videoEl.videoWidth;
    canvas.height = this.videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.videoEl, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    this.closeCamera();
    this.showCropper(dataUrl);
  }

  closeCamera() {
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(t => t.stop());
      this.currentStream = null;
    }
    this.cameraOverlay.style.display = "none";
    this.body.style.display = "flex";
    this.header.style.display = "flex";
    const footer = this.contentEl.querySelector(".handwriting-footer");
    if (footer) footer.style.display = "";
  }

  // ==================== 相册逻辑 ====================
  openAlbum() {
    this.albumInput.click();
  }

  handleFileSelect(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      new Notice("Please select an image file");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      this.showCropper(event.target.result);
    };
    reader.onerror = () => {
      new Notice("Failed to read image");
    };
    reader.readAsDataURL(file);
  }

  // ==================== 工具栏显隐切换 ====================
  toggleToolbar() {
    this.toolbarCollapsed = !this.toolbarCollapsed;
    const container = this.contentEl.querySelector(".toolbar-container") || document.querySelector(".toolbar-container.toolbar-fullscreen");
    const toggleBtn = container?.querySelector(".toolbar-toggle-btn");
    if (container) {
      if (container.classList) {
        container.classList.toggle("collapsed", this.toolbarCollapsed);
      }
    }
    if (toggleBtn) {
      toggleBtn.textContent = this.toolbarCollapsed ? "▶" : "◀";
      toggleBtn.setAttr("aria-label", this.toolbarCollapsed ? "Expand toolbar" : "Collapse toolbar");
    }
  }

  // ==================== 工具栏高度自适应 ====================
  syncToolbarHeight() {
    const toolbar = this.contentEl.querySelector(".floating-toolbar") || document.querySelector(".toolbar-fullscreen .floating-toolbar");
    if (!toolbar) return;
    if (window.innerWidth <= 768) {
      // 移动端：工具栏高度跟随画布或屏幕可视高度
      const wrapper = this.canvas?.parentElement;
      const refHeight = (wrapper && wrapper.clientHeight) ? wrapper.clientHeight : window.innerHeight;
      toolbar.style.maxHeight = Math.max(200, refHeight - 16) + "px";
    } else {
      toolbar.style.maxHeight = "";
    }
  }
  // ==================== 模式切换 ====================
  setMode(mode) {
    this.mode = mode;
    this.isPanning = false;
    this.updateModeUI();
    this.canvas.style.cursor = mode === 'hand' ? "grab" : (mode === 'eraser' ? "pointer" : "crosshair");
    this.statusEl.setText(`Mode: ${mode === 'pen' ? 'Pen' : mode === 'eraser' ? 'Eraser' : 'Hand (pan)'}`);
  }

  updateModeUI() {
    if (!this.penBtn || !this.eraserBtn || !this.handBtn) return;
    this.penBtn.toggleClass("active", this.mode === 'pen');
    this.eraserBtn.toggleClass("active", this.mode === 'eraser');
    this.handBtn.toggleClass("active", this.mode === 'hand');
  }

  // ==================== 坐标转换 ====================
  screenToWorld(screenX, screenY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const canvasX = (screenX - rect.left) * scaleX;
    const canvasY = (screenY - rect.top) * scaleY;
    return {
      x: (canvasX - this.offsetX) / this.scale,
      y: (canvasY - this.offsetY) / this.scale,
    };
  }

  worldToScreen(worldX, worldY) {
    return {
      x: worldX * this.scale + this.offsetX,
      y: worldY * this.scale + this.offsetY,
    };
  }

  setupContext(ctx) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = this.settings.strokeColor;
    ctx.lineWidth = this.settings.strokeWidth;
  }

  clearBackground(ctx, w, h) {
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, w, h);
  }

  drawGrid() {
    if (!this.showGrid) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const step = 50;

    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
    ctx.strokeStyle = "rgba(200, 200, 200, 0.35)";
    ctx.lineWidth = 1 / this.scale;

    for (let x = 0; x <= w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ==================== 绘制核心 ====================
  redrawCanvas(includeCurrent = true) {
    this.clearBackground(this.ctx, this.canvas.width, this.canvas.height);
    this.drawGrid();

    this.ctx.save();
    this.ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
    this.setupContext(this.ctx);

    for (const stroke of this.strokes) {
      if (stroke.length === 0) continue;
      this.ctx.beginPath();
      this.ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) {
        this.ctx.lineTo(stroke[i].x, stroke[i].y);
      }
      this.ctx.stroke();
    }

    if (includeCurrent && this.currentStroke.length > 0) {
      this.ctx.beginPath();
      this.ctx.moveTo(this.currentStroke[0].x, this.currentStroke[0].y);
      for (let i = 1; i < this.currentStroke.length; i++) {
        this.ctx.lineTo(this.currentStroke[i].x, this.currentStroke[i].y);
      }
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  // 无限画布：不做任何平移限制
  clampOffset() {
    // 空函数，允许自由平移
  }

  startDrawing(worldX, worldY) {
    this.isDrawing = true;
    this.currentStroke = [{ x: worldX, y: worldY }];
    this.ctx.save();
    this.ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
    this.setupContext(this.ctx);
    this.ctx.beginPath();
    this.ctx.moveTo(worldX, worldY);
  }

  draw(worldX, worldY) {
    if (!this.isDrawing) return;
    this.currentStroke.push({ x: worldX, y: worldY });
    const expanded = this.expandCanvasIfNeeded(worldX, worldY);
    if (!expanded) {
      this.ctx.lineTo(worldX, worldY);
      this.ctx.stroke();
    }
  }

  stopDrawing() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    try { this.ctx.restore(); } catch (e) {}
    if (this.currentStroke.length > 0) {
      this.strokes.push([...this.currentStroke]);
    }
    this.currentStroke = [];
  }

  eraseAt(worldPos) {
    const threshold = 25 / this.scale;
    let changed = false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes[i];
      for (const p of stroke) {
        if (Math.hypot(p.x - worldPos.x, p.y - worldPos.y) < threshold) {
          this.strokes.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.redrawCanvas();
      this.statusEl.setText(`Erased! ${this.strokes.length} strokes left`);
    }
  }

  expandCanvasIfNeeded(worldX, worldY) {
    let needsExpand = false;
    let newWidth = this.canvas.width;
    let newHeight = this.canvas.height;
    let dx = 0, dy = 0;

    if (worldX + this.expandThreshold >= this.canvas.width) {
      newWidth = this.canvas.width + this.expandDelta;
      needsExpand = true;
    }
    if (worldY + this.expandThreshold >= this.canvas.height) {
      newHeight = this.canvas.height + this.expandDelta;
      needsExpand = true;
    }
    if (worldX - this.expandThreshold <= 0) {
      dx = this.expandDelta;
      newWidth = this.canvas.width + this.expandDelta;
      needsExpand = true;
    }
    if (worldY - this.expandThreshold <= 0) {
      dy = this.expandDelta;
      newHeight = this.canvas.height + this.expandDelta;
      needsExpand = true;
    }

    if (needsExpand) {
      this.expandCanvas(newWidth, newHeight, dx, dy);
      return true;
    }
    return false;
  }

  expandCanvas(newWidth, newHeight, dx = 0, dy = 0) {
    if (dx > 0 || dy > 0) {
      for (const stroke of this.strokes) {
        for (const p of stroke) { p.x += dx; p.y += dy; }
      }
      if (this.currentStroke.length > 0) {
        for (const p of this.currentStroke) { p.x += dx; p.y += dy; }
      }
      this.offsetX -= dx * this.scale;
      this.offsetY -= dy * this.scale;
    }

    this.canvas.width = newWidth;
    this.canvas.height = newHeight;
    const wrapper = this.canvas.parentElement;
    wrapper.style.width = newWidth + "px";
    wrapper.style.height = newHeight + "px";

    this.setupContext(this.ctx);
    this.clampOffset();

    if (this.isDrawing) {
      this.redrawCanvas(false);
      this.ctx.save();
      this.ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
      this.setupContext(this.ctx);
      this.ctx.beginPath();
      this.ctx.moveTo(this.currentStroke[0].x, this.currentStroke[0].y);
      for (let i = 1; i < this.currentStroke.length; i++) {
        this.ctx.lineTo(this.currentStroke[i].x, this.currentStroke[i].y);
      }
      this.ctx.stroke();
    } else {
      this.redrawCanvas();
    }

    this.statusEl.setText(`Canvas: ${newWidth}×${newHeight}`);
  }

  zoomBy(factor) {
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    const wrapper = this.canvas.parentElement;
    const cx = wrapper.clientWidth / 2;
    const cy = wrapper.clientHeight / 2;
    const worldCX = (cx - this.offsetX) / this.scale;
    const worldCY = (cy - this.offsetY) / this.scale;
    this.scale = newScale;
    this.offsetX = cx - worldCX * newScale;
    this.offsetY = cy - worldCY * newScale;
    this.clampOffset();
    this.redrawCanvas();
    this.statusEl.setText(`Zoom: ${Math.round(this.scale * 100)}%`);
  }

  resetView() {
    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.clampOffset();
    this.redrawCanvas();
    this.statusEl.setText("View reset");
    new Notice("View reset");
  }

  fitViewToStrokes() {
    if (this.strokes.length === 0 && this.currentStroke.length === 0) {
      this.resetView();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const allPoints = [];
    for (const s of this.strokes) allPoints.push(...s);
    if (this.currentStroke.length > 0) allPoints.push(...this.currentStroke);
    for (const p of allPoints) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const padding = 60;
    minX -= padding; minY -= padding; maxX += padding; maxY += padding;
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const wrapper = this.canvas.parentElement;
    const viewW = wrapper.clientWidth;
    const viewH = wrapper.clientHeight;
    const scaleX = viewW / contentW;
    const scaleY = viewH / contentH;
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, Math.min(scaleX, scaleY)));
    this.offsetX = (viewW - contentW * this.scale) / 2 - minX * this.scale;
    this.offsetY = (viewH - contentH * this.scale) / 2 - minY * this.scale;
    this.clampOffset();
    this.redrawCanvas();
    this.statusEl.setText("Fit to content");
  }

  rotateCanvas(clockwise) {
    if (this.isDrawing) this.stopDrawing();
    if (this.strokes.length === 0 && this.currentStroke.length === 0) {
      new Notice("Nothing to rotate");
      return;
    }

    const oldWidth = this.canvas.width;
    const oldHeight = this.canvas.height;
    const newWidth = oldHeight;
    const newHeight = oldWidth;

    const transform = (p) => {
      return clockwise
        ? { x: p.y, y: oldWidth - 1 - p.x }
        : { x: oldHeight - 1 - p.y, y: p.x };
    };

    this.strokes = this.strokes.map(stroke => stroke.map(transform));
    if (this.currentStroke.length > 0) {
      this.currentStroke = this.currentStroke.map(transform);
    }

    this.canvas.width = newWidth;
    this.canvas.height = newHeight;
    const wrapper = this.canvas.parentElement;
    wrapper.style.width = newWidth + "px";
    wrapper.style.height = newHeight + "px";

    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1.0;
    this.setupContext(this.ctx);
    this.redrawCanvas();

    this.statusEl.setText(`Rotated ${clockwise ? 'clockwise' : 'counter-clockwise'}`);
    new Notice(`Rotated ${clockwise ? '90° clockwise' : '90° counter-clockwise'}`);
  }

  bindCanvasEvents(canvas) {
    const getWorldPos = (touch) => this.screenToWorld(touch.clientX, touch.clientY);

    const onTouchStart = (e) => {
      e.preventDefault();

      if (e.touches.length === 1) {
        const pos = getWorldPos(e.touches[0]);
        const canvasPos = {
          x: (e.touches[0].clientX - this.canvas.getBoundingClientRect().left) * (this.canvas.width / this.canvas.getBoundingClientRect().width),
          y: (e.touches[0].clientY - this.canvas.getBoundingClientRect().top) * (this.canvas.height / this.canvas.getBoundingClientRect().height)
        };

        if (this.mode === 'hand') {
          this.isPanning = true;
          this.panStart = canvasPos;
          this.panStartOffset = { x: this.offsetX, y: this.offsetY };
          canvas.style.cursor = "grabbing";
        } else if (this.mode === 'eraser') {
          this.eraseAt(pos);
        } else {
          this.startDrawing(pos.x, pos.y);
        }
      } else if (e.touches.length === 2) {
        if (this.isDrawing) this.stopDrawing();
        this.isPanning = true;

        const t1 = getWorldPos(e.touches[0]);
        const t2 = getWorldPos(e.touches[1]);
        const c1 = {
          x: (e.touches[0].clientX - this.canvas.getBoundingClientRect().left) * (this.canvas.width / this.canvas.getBoundingClientRect().width),
          y: (e.touches[0].clientY - this.canvas.getBoundingClientRect().top) * (this.canvas.height / this.canvas.getBoundingClientRect().height)
        };
        const c2 = {
          x: (e.touches[1].clientX - this.canvas.getBoundingClientRect().left) * (this.canvas.width / this.canvas.getBoundingClientRect().width),
          y: (e.touches[1].clientY - this.canvas.getBoundingClientRect().top) * (this.canvas.height / this.canvas.getBoundingClientRect().height)
        };

        this.pinchState = {
          startDistance: Math.hypot(c1.x - c2.x, c1.y - c2.y),
          startScale: this.scale,
          startCenter: { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 },
          startOffset: { x: this.offsetX, y: this.offsetY },
          worldAnchor: { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 },
        };
      }
    };

    const onTouchMove = (e) => {
      e.preventDefault();

      if (e.touches.length === 1) {
        const pos = getWorldPos(e.touches[0]);
        const canvasPos = {
          x: (e.touches[0].clientX - this.canvas.getBoundingClientRect().left) * (this.canvas.width / this.canvas.getBoundingClientRect().width),
          y: (e.touches[0].clientY - this.canvas.getBoundingClientRect().top) * (this.canvas.height / this.canvas.getBoundingClientRect().height)
        };

        if (this.mode === 'hand' && this.isPanning) {
          this.offsetX = this.panStartOffset.x + (canvasPos.x - this.panStart.x);
          this.offsetY = this.panStartOffset.y + (canvasPos.y - this.panStart.y);
          this.clampOffset();
          this.redrawCanvas();
        } else if (this.mode === 'eraser') {
          this.eraseAt(pos);
        } else if (this.isDrawing) {
          this.draw(pos.x, pos.y);
        }
      } else if (e.touches.length === 2 && this.isPanning && this.pinchState) {
        const c1 = {
          x: (e.touches[0].clientX - this.canvas.getBoundingClientRect().left) * (this.canvas.width / this.canvas.getBoundingClientRect().width),
          y: (e.touches[0].clientY - this.canvas.getBoundingClientRect().top) * (this.canvas.height / this.canvas.getBoundingClientRect().height)
        };
        const c2 = {
          x: (e.touches[1].clientX - this.canvas.getBoundingClientRect().left) * (this.canvas.width / this.canvas.getBoundingClientRect().width),
          y: (e.touches[1].clientY - this.canvas.getBoundingClientRect().top) * (this.canvas.height / this.canvas.getBoundingClientRect().height)
        };

        const currentDistance = Math.hypot(c1.x - c2.x, c1.y - c2.y);
        const currentCenter = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };

        let newScale = this.scale;
        if (this.pinchState.startDistance > 10) {
          newScale = this.pinchState.startScale * (currentDistance / this.pinchState.startDistance);
        }
        newScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

        const worldAtAnchor = {
          x: (this.pinchState.startCenter.x - this.pinchState.startOffset.x) / this.pinchState.startScale,
          y: (this.pinchState.startCenter.y - this.pinchState.startOffset.y) / this.pinchState.startScale
        };

        this.scale = newScale;
        this.offsetX = currentCenter.x - worldAtAnchor.x * newScale;
        this.offsetY = currentCenter.y - worldAtAnchor.y * newScale;

        this.clampOffset();
        this.redrawCanvas();
      }
    };

    const onTouchEnd = (e) => {
      e.preventDefault();
      if (this.isDrawing) this.stopDrawing();
      if (this.isPanning && e.touches.length < 2) {
        this.isPanning = false;
        this.pinchState = null;
        canvas.style.cursor = this.mode === 'hand' ? "grab" : (this.mode === 'eraser' ? "pointer" : "crosshair");
      }
    };

    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchEnd);

    canvas.addEventListener("mousedown", (e) => {
      if (this.mode === 'hand') {
        this.isPanning = true;
        this.panStart = { x: e.offsetX * (this.canvas.width / this.canvas.getBoundingClientRect().width), y: e.offsetY * (this.canvas.height / this.canvas.getBoundingClientRect().height) };
        this.panStartOffset = { x: this.offsetX, y: this.offsetY };
      } else if (this.mode === 'eraser') {
        const pos = this.screenToWorld(e.clientX, e.clientY);
        this.eraseAt(pos);
      } else {
        const pos = this.screenToWorld(e.clientX, e.clientY);
        this.startDrawing(pos.x, pos.y);
      }
    });
    canvas.addEventListener("mousemove", (e) => {
      if (this.mode === 'hand' && this.isPanning) {
        const canvasPos = { x: e.offsetX * (this.canvas.width / this.canvas.getBoundingClientRect().width), y: e.offsetY * (this.canvas.height / this.canvas.getBoundingClientRect().height) };
        this.offsetX = this.panStartOffset.x + (canvasPos.x - this.panStart.x);
        this.offsetY = this.panStartOffset.y + (canvasPos.y - this.panStart.y);
        this.clampOffset();
        this.redrawCanvas();
      } else if (this.mode === 'eraser' && e.buttons === 1) {
        const pos = this.screenToWorld(e.clientX, e.clientY);
        this.eraseAt(pos);
      } else if (this.isDrawing) {
        const pos = this.screenToWorld(e.clientX, e.clientY);
        this.draw(pos.x, pos.y);
      }
    });
    const endMouse = () => {
      if (this.isDrawing) this.stopDrawing();
      this.isPanning = false;
    };
    canvas.addEventListener("mouseup", endMouse);
    canvas.addEventListener("mouseout", endMouse);

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = canvas.getBoundingClientRect();
      const canvasPos = {
        x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
        y: (e.clientY - rect.top) * (this.canvas.height / rect.height)
      };
      const worldPos = {
        x: (canvasPos.x - this.offsetX) / this.scale,
        y: (canvasPos.y - this.offsetY) / this.scale
      };
      let newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
      this.scale = newScale;
      this.offsetX = canvasPos.x - worldPos.x * newScale;
      this.offsetY = canvasPos.y - worldPos.y * newScale;
      this.clampOffset();
      this.redrawCanvas();
    }, { passive: false });
  }

  bindResizeEvents(handle, wrapper) {
    const startResize = (clientX, clientY) => {
      if (this.isFullscreen) return;
      this.resizeStart = { x: clientX, y: clientY };
      const rect = wrapper.getBoundingClientRect();
      this.wrapperStart = { width: rect.width, height: rect.height };
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";
      wrapper.classList.add("resizing");
    };

    const doResize = (clientX, clientY) => {
      if (!this.resizeStart || !this.wrapperStart || this.isFullscreen) return;
      const dx = clientX - this.resizeStart.x;
      const dy = clientY - this.resizeStart.y;
      let newW = Math.max(300, Math.round(this.wrapperStart.width + dx));
      let newH = Math.max(200, Math.round(this.wrapperStart.height + dy));
      newW = Math.min(newW, this.canvas.width);
      newH = Math.min(newH, this.canvas.height);
      wrapper.style.width = newW + "px";
      wrapper.style.height = newH + "px";
      this.clampOffset();
      this.redrawCanvas();
    };

    const endResize = () => {
      this.resizeStart = null;
      this.wrapperStart = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      wrapper.classList.remove("resizing");
    };

    handle.addEventListener("mousedown", (e) => {
      if (this.isFullscreen) return;
      e.stopPropagation(); e.preventDefault();
      startResize(e.clientX, e.clientY);
    });

    const mm = (e) => { if (this.resizeStart) { e.preventDefault(); doResize(e.clientX, e.clientY); } };
    const mu = () => { if (this.resizeStart) endResize(); };
    document.addEventListener("mousemove", mm);
    document.addEventListener("mouseup", mu);

    handle.addEventListener("touchstart", (e) => {
      if (this.isFullscreen) return;
      e.stopPropagation(); e.preventDefault();
      if (e.touches.length > 0) startResize(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    const tm = (e) => { if (this.resizeStart && e.touches.length > 0) { e.preventDefault(); doResize(e.touches[0].clientX, e.touches[0].clientY); } };
    const te = () => { if (this.resizeStart) endResize(); };
    document.addEventListener("touchmove", tm, { passive: false });
    document.addEventListener("touchend", te);

    this._cleanupResize = () => {
      document.removeEventListener("mousemove", mm);
      document.removeEventListener("mouseup", mu);
      document.removeEventListener("touchmove", tm);
      document.removeEventListener("touchend", te);
    };
  }

  toggleFullscreen() {
    this.isFullscreen ? this.exitFullscreen() : this.enterFullscreen();
  }

  enterFullscreen() {
    if (this.isFullscreen) return;
    const wrapper = this.canvas.parentElement;
    this.savedWrapperStyles = {
      position: wrapper.style.position, top: wrapper.style.top, left: wrapper.style.left,
      width: wrapper.style.width, height: wrapper.style.height, zIndex: wrapper.style.zIndex,
      backgroundColor: wrapper.style.backgroundColor, overflow: wrapper.style.overflow,
    };
    wrapper.style.position = "fixed";
    wrapper.style.top = "0"; wrapper.style.left = "0";
    wrapper.style.width = "100vw"; wrapper.style.height = "100vh";
    wrapper.style.zIndex = "99999"; wrapper.style.backgroundColor = "white"; wrapper.style.overflow = "hidden";

    // Move toolbar to document.body so it stays visible above fullscreen wrapper
    const toolbarContainer = this.contentEl.querySelector(".toolbar-container");
    if (toolbarContainer) {
      this.savedToolbarParent = toolbarContainer.parentElement;
      this.savedToolbarNextSibling = toolbarContainer.nextSibling;
      toolbarContainer.classList.add("toolbar-fullscreen");
      document.body.appendChild(toolbarContainer);
      // Update toggle button arrow direction for fullscreen position
      const toggleBtn = toolbarContainer.querySelector(".toolbar-toggle-btn");
      if (toggleBtn && !this.toolbarCollapsed) {
        toggleBtn.textContent = "◀";
      }
      this.syncToolbarHeight();
    }

    const exitBtn = document.createElement("button");
    exitBtn.textContent = "Exit Fullscreen";
    exitBtn.className = "handwriting-fullscreen-exit";
    exitBtn.style.cssText = `position:fixed;top:16px;right:16px;padding:12px 20px;font-size:16px;background:var(--interactive-accent,#7c3aed);color:white;border:none;border-radius:8px;cursor:pointer;z-index:100000;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-weight:600;`;
    exitBtn.addEventListener("click", () => this.exitFullscreen());
    document.body.appendChild(exitBtn);
    this.fullscreenExitBtn = exitBtn;

    const resizeHandle = wrapper.querySelector(".resize-handle");
    if (resizeHandle) resizeHandle.style.display = "none";
    this.isFullscreen = true;
    this.clampOffset();
    this.redrawCanvas();
  }

  exitFullscreen() {
    if (!this.isFullscreen) return;
    const wrapper = this.canvas.parentElement;
    if (this.savedWrapperStyles) {
      wrapper.style.position = this.savedWrapperStyles.position || "";
      wrapper.style.top = this.savedWrapperStyles.top || "";
      wrapper.style.left = this.savedWrapperStyles.left || "";
      wrapper.style.width = this.savedWrapperStyles.width || "";
      wrapper.style.height = this.savedWrapperStyles.height || "";
      wrapper.style.zIndex = this.savedWrapperStyles.zIndex || "";
      wrapper.style.backgroundColor = this.savedWrapperStyles.backgroundColor || "";
      wrapper.style.overflow = this.savedWrapperStyles.overflow || "";
    } else {
      wrapper.style.position = "relative";
      wrapper.style.width = this.settings.canvasWidth + "px";
      wrapper.style.height = this.settings.canvasHeight + "px";
      wrapper.style.zIndex = ""; wrapper.style.backgroundColor = ""; wrapper.style.overflow = "hidden";
    }
    if (this.fullscreenExitBtn) { this.fullscreenExitBtn.remove(); this.fullscreenExitBtn = null; }
    const resizeHandle = wrapper.querySelector(".resize-handle");
    if (resizeHandle) resizeHandle.style.display = "";

    // Restore toolbar from body back to canvas-area
    const toolbarContainer = document.querySelector(".toolbar-container.toolbar-fullscreen");
    if (toolbarContainer && this.savedToolbarParent) {
      toolbarContainer.classList.remove("toolbar-fullscreen");
      if (this.savedToolbarNextSibling) {
        this.savedToolbarParent.insertBefore(toolbarContainer, this.savedToolbarNextSibling);
      } else {
        this.savedToolbarParent.appendChild(toolbarContainer);
      }
      this.savedToolbarParent = null;
      this.savedToolbarNextSibling = null;
      if (this.toolbarCollapsed) {
        toolbarContainer.classList.add("collapsed");
      }
      this.syncToolbarHeight();
    }

    this.isFullscreen = false;
    this.clampOffset();
    this.redrawCanvas();
  }

  getFullCanvasImage() {
    if (this.strokes.length === 0 && this.currentStroke.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const allPoints = [];
    for (const s of this.strokes) allPoints.push(...s);
    if (this.currentStroke.length > 0) allPoints.push(...this.currentStroke);

    for (const p of allPoints) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const padding = 20;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const width = Math.max(1, Math.ceil(maxX - minX));
    const height = Math.max(1, Math.ceil(maxY - minY));

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext("2d");

    tempCtx.fillStyle = "white";
    tempCtx.fillRect(0, 0, width, height);

    if (this.showGrid) {
      tempCtx.strokeStyle = "rgba(200, 200, 200, 0.35)";
      tempCtx.lineWidth = 1;
      const step = 50;
      const startX = Math.floor(minX / step) * step;
      const startY = Math.floor(minY / step) * step;
      for (let x = startX; x <= maxX; x += step) {
        tempCtx.beginPath();
        tempCtx.moveTo(x - minX, 0);
        tempCtx.lineTo(x - minX, height);
        tempCtx.stroke();
      }
      for (let y = startY; y <= maxY; y += step) {
        tempCtx.beginPath();
        tempCtx.moveTo(0, y - minY);
        tempCtx.lineTo(width, y - minY);
        tempCtx.stroke();
      }
    }

    tempCtx.lineCap = "round";
    tempCtx.lineJoin = "round";
    tempCtx.strokeStyle = this.settings.strokeColor;
    tempCtx.lineWidth = this.settings.strokeWidth;

    for (const stroke of this.strokes) {
      if (stroke.length === 0) continue;
      tempCtx.beginPath();
      tempCtx.moveTo(stroke[0].x - minX, stroke[0].y - minY);
      for (let i = 1; i < stroke.length; i++) {
        tempCtx.lineTo(stroke[i].x - minX, stroke[i].y - minY);
      }
      tempCtx.stroke();
    }

    if (this.currentStroke.length > 0) {
      tempCtx.beginPath();
      tempCtx.moveTo(this.currentStroke[0].x - minX, this.currentStroke[0].y - minY);
      for (let i = 1; i < this.currentStroke.length; i++) {
        tempCtx.lineTo(this.currentStroke[i].x - minX, this.currentStroke[i].y - minY);
      }
      tempCtx.stroke();
    }

    return tempCanvas.toDataURL("image/png");
  }

  async getFullCanvasBlob() {
    const dataUrl = this.getFullCanvasImage();
    if (!dataUrl) return null;
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  clearCanvas() {
    this.strokes = []; this.currentStroke = [];
    this.offsetX = 0; this.offsetY = 0; this.scale = 1.0;
    this.clearBackground(this.ctx, this.canvas.width, this.canvas.height);
    this.drawGrid();
    this.resultEl.setText("(No result yet)");
    this.statusEl.setText("Canvas cleared");
    new Notice("Canvas cleared");
  }

  undoLastStroke() {
    if (this.strokes.length === 0) return;
    this.strokes.pop();
    this.redrawCanvas();
    this.statusEl.setText(`Undo: ${this.strokes.length} strokes left`);
  }

  // ==================== 裁剪器（修复版） ====================
  showCropper(dataUrl) {
    this.cropperImage.src = dataUrl;
    this.cropperImage.onload = () => {
      this.cropperOverlay.style.display = "flex";
      this.body.style.display = "none";
      this.header.style.display = "none";
      const footer = this.contentEl.querySelector(".handwriting-footer");
      if (footer) footer.style.display = "none";

      requestAnimationFrame(() => {
        this.initCropperView();
        this.cropperSelectionData = null;
        this.cropperSelection.style.display = "none";
        this.updateCropperMask();
      });
    };
    this.cropperImage.onerror = () => {
      new Notice("Failed to load image");
    };
  }

  hideCropper() {
    this.cropperOverlay.style.display = "none";
    this.body.style.display = "flex";
    this.header.style.display = "flex";
    const footer = this.contentEl.querySelector(".handwriting-footer");
    if (footer) footer.style.display = "";
  }

  // ==================== 修复裁剪器交互（支持手柄拖拽，拖拽创建选框） ====================
  bindCropperEvents() {
    const wrapper = this.cropperWrapper;
    let isDragging = false;
    let dragMode = null;          // 'resize', 'move', 'select', 'pinch'
    let resizeHandle = null;
    let startPos = null;          // 屏幕坐标（相对wrapper）
    let startImagePos = null;     // 图片坐标
    let startSelection = null;    // 移动/调整前的 selection 副本
    let selectStartPos = null;    // 选择框起始屏幕坐标
    let selectStartImagePos = null; // 选择框起始图片坐标
    let hasMovedEnough = false;   // 是否拖动超过阈值

    let touchStartDistance = 0;
    let touchStartScale = 1;
    let touchStartCenter = null;
    let touchStartOffset = null;
    let activeTouches = new Map();

    const getPos = (e) => {
      const rect = wrapper.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: clientX - rect.left, y: clientY - rect.top, clientX, clientY };
    };

    const getHandleAt = (screenX, screenY) => {
      if (!this.cropperSelectionData) return null;
      const sel = this.cropperSelectionData;
      const tl = this.imagePixelToScreen(sel.x, sel.y);
      const br = this.imagePixelToScreen(sel.x + sel.width, sel.y + sel.height);

      const handleSize = window.innerWidth <= 768 ? 44 : 20;
      const half = handleSize / 2;
      const handles = [
        { name: 'nw', x: tl.x, y: tl.y },
        { name: 'ne', x: br.x, y: tl.y },
        { name: 'sw', x: tl.x, y: br.y },
        { name: 'se', x: br.x, y: br.y },
        { name: 'n', x: (tl.x + br.x) / 2, y: tl.y },
        { name: 's', x: (tl.x + br.x) / 2, y: br.y },
        { name: 'w', x: tl.x, y: (tl.y + br.y) / 2 },
        { name: 'e', x: br.x, y: (tl.y + br.y) / 2 },
      ];

      for (const h of handles) {
        if (Math.abs(screenX - h.x) < half && Math.abs(screenY - h.y) < half) {
          return h.name;
        }
      }
      return null;
    };

    const isInsideSelection = (screenX, screenY) => {
      if (!this.cropperSelectionData) return false;
      const sel = this.cropperSelectionData;
      const tl = this.imagePixelToScreen(sel.x, sel.y);
      const br = this.imagePixelToScreen(sel.x + sel.width, sel.y + sel.height);
      return screenX >= tl.x && screenX <= br.x && screenY >= tl.y && screenY <= br.y;
    };

    const onStart = (e) => {
      if (e.type === 'touchstart') {
        for (let i = 0; i < e.touches.length; i++) {
          activeTouches.set(e.touches[i].identifier, { x: e.touches[i].clientX, y: e.touches[i].clientY });
        }
      }

      // 双指缩放
      if (e.touches && e.touches.length === 2) {
        e.preventDefault();
        isDragging = true;
        dragMode = 'pinch';
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        touchStartDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        touchStartScale = this.cropperImageScale;
        touchStartCenter = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
        touchStartOffset = { x: this.cropperImageOffsetX, y: this.cropperImageOffsetY };
        return;
      }

      const pos = getPos(e);

      // 1. 检测手柄（鼠标和触摸均有效）
      const handle = getHandleAt(pos.x, pos.y);
      if (handle) {
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        dragMode = 'resize';
        resizeHandle = handle;
        startPos = pos;
        startSelection = { ...this.cropperSelectionData };
        return;
      }

      // 2. 检测是否在选中框内（移动）
      if (isInsideSelection(pos.x, pos.y)) {
        e.preventDefault();
        isDragging = true;
        dragMode = 'move';
        startPos = pos;
        startSelection = { ...this.cropperSelectionData };
        startImagePos = this.screenToImagePixel(pos.clientX, pos.clientY);
        wrapper.style.cursor = "move";
        return;
      }

      // 3. 否则准备创建新选框（仅记录起始点，不立即创建）
      e.preventDefault();
      isDragging = true;
      dragMode = 'select';
      selectStartPos = { x: pos.x, y: pos.y, clientX: pos.clientX, clientY: pos.clientY };
      selectStartImagePos = this.screenToImagePixel(pos.clientX, pos.clientY);
      hasMovedEnough = false;
      // 清除旧选择
      if (this.cropperSelectionData) {
        this.cropperSelectionData = null;
        this.cropperSelection.style.display = "none";
        this.updateCropperMask();
      }
    };

    const onMove = (e) => {
      if (!isDragging) return;

      if (e.type === 'touchmove') {
        for (let i = 0; i < e.touches.length; i++) {
          activeTouches.set(e.touches[i].identifier, { x: e.touches[i].clientX, y: e.touches[i].clientY });
        }
      }

      // 双指缩放
      if (dragMode === 'pinch' && e.touches && e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const distance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        if (touchStartDistance > 0) {
          const newScale = touchStartScale * (distance / touchStartDistance);
          this.cropperImageScale = Math.max(0.1, Math.min(5, newScale));
        }

        const center = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
        const rect = wrapper.getBoundingClientRect();
        const centerX = center.x - rect.left;
        const centerY = center.y - rect.top;
        const worldCenterX = (centerX - touchStartOffset.x) / touchStartScale;
        const worldCenterY = (centerY - touchStartOffset.y) / touchStartScale;
        this.cropperImageOffsetX = centerX - worldCenterX * this.cropperImageScale;
        this.cropperImageOffsetY = centerY - worldCenterY * this.cropperImageScale;

        this.applyCropperTransform();
        return;
      }

      if (dragMode === 'pinch') return;

      e.preventDefault();
      const pos = getPos(e);
      const currentImagePos = this.screenToImagePixel(pos.clientX, pos.clientY);

      if (dragMode === 'select') {
        // 只有拖动超过阈值才创建选框
        const dx = pos.x - selectStartPos.x;
        const dy = pos.y - selectStartPos.y;
        if (Math.hypot(dx, dy) > 5) {
          if (!this.cropperSelectionData) {
            // 首次创建
            const x = Math.min(selectStartImagePos.x, currentImagePos.x);
            const y = Math.min(selectStartImagePos.y, currentImagePos.y);
            const width = Math.abs(currentImagePos.x - selectStartImagePos.x);
            const height = Math.abs(currentImagePos.y - selectStartImagePos.y);
            this.cropperSelectionData = { x, y, width, height };
            this.cropperSelection.style.display = "block";
            hasMovedEnough = true;
          } else {
            // 更新选框
            const x = Math.min(selectStartImagePos.x, currentImagePos.x);
            const y = Math.min(selectStartImagePos.y, currentImagePos.y);
            const width = Math.abs(currentImagePos.x - selectStartImagePos.x);
            const height = Math.abs(currentImagePos.y - selectStartImagePos.y);
            this.cropperSelectionData.x = x;
            this.cropperSelectionData.y = y;
            this.cropperSelectionData.width = width;
            this.cropperSelectionData.height = height;
          }
          this.updateSelectionDisplay();
          this.updateCropperMask();
        }
        return;
      }

      // resize / move 模式
      if (dragMode === 'move') {
        const dx = currentImagePos.x - startImagePos.x;
        const dy = currentImagePos.y - startImagePos.y;
        this.cropperSelectionData = {
          x: startSelection.x + dx,
          y: startSelection.y + dy,
          width: startSelection.width,
          height: startSelection.height
        };
        this.updateSelectionDisplay();
        this.updateCropperMask();
      } else if (dragMode === 'resize' && resizeHandle) {
        let { x, y, width, height } = startSelection;

        switch (resizeHandle) {
          case 'nw':
            x = Math.min(currentImagePos.x, startSelection.x + startSelection.width);
            y = Math.min(currentImagePos.y, startSelection.y + startSelection.height);
            width = Math.abs(startSelection.x + startSelection.width - currentImagePos.x);
            height = Math.abs(startSelection.y + startSelection.height - currentImagePos.y);
            break;
          case 'ne':
            x = startSelection.x;
            y = Math.min(currentImagePos.y, startSelection.y + startSelection.height);
            width = Math.abs(currentImagePos.x - startSelection.x);
            height = Math.abs(startSelection.y + startSelection.height - currentImagePos.y);
            break;
          case 'sw':
            x = Math.min(currentImagePos.x, startSelection.x + startSelection.width);
            y = startSelection.y;
            width = Math.abs(startSelection.x + startSelection.width - currentImagePos.x);
            height = Math.abs(currentImagePos.y - startSelection.y);
            break;
          case 'se':
            x = startSelection.x;
            y = startSelection.y;
            width = Math.abs(currentImagePos.x - startSelection.x);
            height = Math.abs(currentImagePos.y - startSelection.y);
            break;
          case 'n':
            y = Math.min(currentImagePos.y, startSelection.y + startSelection.height);
            height = Math.abs(startSelection.y + startSelection.height - currentImagePos.y);
            break;
          case 's':
            height = Math.abs(currentImagePos.y - startSelection.y);
            break;
          case 'w':
            x = Math.min(currentImagePos.x, startSelection.x + startSelection.width);
            width = Math.abs(startSelection.x + startSelection.width - currentImagePos.x);
            break;
          case 'e':
            width = Math.abs(currentImagePos.x - startSelection.x);
            break;
        }

        this.cropperSelectionData = { x, y, width, height };
        this.updateSelectionDisplay();
        this.updateCropperMask();
      }
    };

    const onEnd = (e) => {
      if (e.type === 'touchend' || e.type === 'touchcancel') {
        for (let i = 0; i < e.changedTouches.length; i++) {
          activeTouches.delete(e.changedTouches[i].identifier);
        }
        if (activeTouches.size > 0) {
          if (activeTouches.size === 1 && dragMode === 'pinch') {
            // 从双指变为单指，转为选择模式
            dragMode = 'select';
            const touch = Array.from(activeTouches.values())[0];
            const rect = wrapper.getBoundingClientRect();
            selectStartPos = { x: touch.x - rect.left, y: touch.y - rect.top, clientX: touch.x, clientY: touch.y };
            selectStartImagePos = this.screenToImagePixel(touch.x, touch.y);
            hasMovedEnough = false;
            // 清除旧选择
            if (this.cropperSelectionData) {
              this.cropperSelectionData = null;
              this.cropperSelection.style.display = "none";
              this.updateCropperMask();
            }
          }
          return;
        }
      }

      // 结束拖拽
      isDragging = false;

      // 如果选择模式但未创建有效选框，清除可能残留的零尺寸框
      if (dragMode === 'select') {
        if (!hasMovedEnough || !this.cropperSelectionData || this.cropperSelectionData.width < 5 || this.cropperSelectionData.height < 5) {
          this.cropperSelectionData = null;
          this.cropperSelection.style.display = "none";
          this.updateCropperMask();
        }
      }

      dragMode = null;
      resizeHandle = null;
      wrapper.style.cursor = "";
      activeTouches.clear();
    };

    wrapper.addEventListener("mousedown", onStart);
    wrapper.addEventListener("mousemove", onMove);
    wrapper.addEventListener("mouseup", onEnd);
    wrapper.addEventListener("mouseleave", onEnd);
    wrapper.addEventListener("touchstart", onStart, { passive: false });
    wrapper.addEventListener("touchmove", onMove, { passive: false });
    wrapper.addEventListener("touchend", onEnd);
    wrapper.addEventListener("touchcancel", onEnd);

    wrapper.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = wrapper.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const worldX = (mouseX - this.cropperImageOffsetX) / this.cropperImageScale;
      const worldY = (mouseY - this.cropperImageOffsetY) / this.cropperImageScale;
      this.cropperImageScale = Math.max(0.1, Math.min(5, this.cropperImageScale * factor));
      this.cropperImageOffsetX = mouseX - worldX * this.cropperImageScale;
      this.cropperImageOffsetY = mouseY - worldY * this.cropperImageScale;
      this.applyCropperTransform();
    }, { passive: false });
  }

  async confirmCropAndRecognize() {
    if (!this.cropperSelectionData || this.cropperSelectionData.width < 10 || this.cropperSelectionData.height < 10) {
      new Notice("Please select a formula area first (drag on image)");
      return;
    }

    const sel = this.cropperSelectionData;
    const sourceX = Math.max(0, Math.round(sel.x));
    const sourceY = Math.max(0, Math.round(sel.y));
    const sourceW = Math.min(this.cropperImage.naturalWidth - sourceX, Math.round(sel.width));
    const sourceH = Math.min(this.cropperImage.naturalHeight - sourceY, Math.round(sel.height));

    if (sourceW <= 0 || sourceH <= 0) {
      new Notice("Invalid selection");
      return;
    }

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = sourceW;
    tempCanvas.height = sourceH;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.drawImage(this.cropperImage, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);

    const base64 = tempCanvas.toDataURL("image/png");
    this.hideCropper();
    await this.recognizeImage(base64);
  }

  // ==================== 识别逻辑 ====================
  async recognizeFormula() {
    if (this.isDrawing) this.stopDrawing();
    if (this.strokes.length === 0) {
      new Notice("Please draw something first!");
      return;
    }

    this.statusEl.setText("Recognizing...");

    try {
      let latex = "";
      const imageBase64 = this.getFullCanvasImage().split(",")[1];
      latex = await this.dispatchRecognize(imageBase64);

      latex = this.cleanLatex(latex);
      this.saveToHistory(latex);
      this.resultEl.setText(latex);
      this.statusEl.setText("Recognition complete!");
      this.resultEl.setAttr("data-latex", latex);

    } catch (error) {
      this.statusEl.setText("Error: " + error.message);
      new Notice("Recognition failed: " + error.message);
      console.error(error);
    }
  }

  async recognizeImage(base64DataUrl) {
    this.statusEl.setText("Recognizing image...");
    try {
      let latex = "";
      const imageBase64 = base64DataUrl.split(",")[1];
      latex = await this.dispatchRecognize(imageBase64);
      latex = this.cleanLatex(latex);
      this.saveToHistory(latex);
      this.resultEl.setText(latex);
      this.statusEl.setText("Image recognition complete!");
      this.resultEl.setAttr("data-latex", latex);

      if (window.innerWidth <= 768) {
        const resultPanel = this.contentEl.querySelector(".result-panel");
        if (resultPanel) {
          resultPanel.classList.add("expanded");
          this.resultExpanded = true;
        }
      }
    } catch (error) {
      this.statusEl.setText("Error: " + error.message);
      new Notice("Image recognition failed: " + error.message);
      console.error(error);
    }
  }

  async dispatchRecognize(imageBase64) {
    switch (this.settings.apiProvider) {
      case "mathpix": return await this.callMathpix(imageBase64);
      case "simpletex": return await this.callSimpletex(imageBase64);
      case "openai": return await this.callOpenAI(imageBase64);
      case "custom": return await this.callCustomAPI(imageBase64);
      case "custom-form": return await this.callCustomFormAPI(imageBase64);
      default:
        if (this.getCustomProviderConfig(this.settings.apiProvider)) {
          return await this.callCustomProvider(imageBase64);
        }
        throw new Error("Unknown API provider: " + this.settings.apiProvider);
    }
  }


  // ==================== API 辅助方法 ====================
  isReasoningModel(model) {
    return /^o\d/.test(model) || model.includes("o1") || model.includes("o3") || model.includes("o4");
  }

  getEffectiveDetail(model, detail) {
    // OpenAI 官方文档：detail: "original" 仅在 gpt-5.4 及未来模型上可用
    // gpt-4o, gpt-4.1, gpt-4o-mini, o-series (except o4-mini) 不支持 original
    if (detail === "original") {
      const supportedOriginalModels = ["gpt-5.4", "gpt-5.5"];
      const isSupported = supportedOriginalModels.some(m => model.startsWith(m));
      if (!isSupported) {
        console.warn(`detail "original" is not supported for model "${model}". Falling back to "high".`);
        return "high";
      }
    }
    return detail;
  }

  parseApiError(response, prefix) {
    let errorMsg = response.text || "Unknown error";
    try {
      const errData = JSON.parse(response.text);
      errorMsg = errData.error?.message || errData.error?.description || errData.message || errData.detail || response.text;
    } catch (e) {
      // 不是 JSON，保持原样
    }
    return new Error(prefix + " (HTTP " + response.status + "): " + errorMsg);
  }

  async callMathpix(imageBase64) {
    if (!this.settings.mathpixAppId) {
      throw new Error("Mathpix App ID is required. Please set it in plugin settings.");
    }
    if (!this.settings.apiKey) {
      throw new Error("Mathpix App Key is required. Please set it in plugin settings.");
    }
    const response = await requestUrl({
      url: "https://api.mathpix.com/v3/text",
      method: "POST",
      headers: {
        "app_id": this.settings.mathpixAppId,
        "app_key": this.settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        src: "data:image/png;base64," + imageBase64,
        formats: ["text", "latex_styled"],
        math_inline_delimiters: ["$", "$"],
        rm_spaces: true,
      }),
    });
    if (response.status !== 200) throw this.parseApiError(response, "Mathpix API error");
    const data = response.json;
    return data.latex_styled || data.text || "";
  }

  async callSimpletex(imageBase64) {
    const blob = this.base64ToBlob(imageBase64);
    const arrayBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
    const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
    const encoder = new TextEncoder();
    const appendString = (buffer, str) => {
      const encoded = encoder.encode(str + "\r\n");
      const newBuffer = new Uint8Array(buffer.length + encoded.length);
      newBuffer.set(buffer);
      newBuffer.set(encoded, buffer.length);
      return newBuffer;
    };
    const appendBytes = (buffer, bytes) => {
      const newBuffer = new Uint8Array(buffer.length + bytes.length);
      newBuffer.set(buffer);
      newBuffer.set(bytes, buffer.length);
      return newBuffer;
    };
    let body = new Uint8Array(0);
    body = appendString(body, "--" + boundary);
    body = appendString(body, 'Content-Disposition: form-data; name="file"; filename="formula.png"');
    body = appendString(body, "Content-Type: image/png");
    body = appendString(body, "");
    const fileBytes = new Uint8Array(arrayBuffer);
    body = appendBytes(body, fileBytes);
    body = appendString(body, "");
    body = appendString(body, "--" + boundary + "--");
    const response = await requestUrl({
      url: "https://server.simpletex.cn/api/latex_ocr",
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "token": this.settings.apiKey,
      },
      body: body.buffer,
    });
    if (response.status !== 200) throw this.parseApiError(response, "SimpleTex API error");
    const data = response.json;
    if (!data.status) throw new Error("SimpleTex API returned error: " + JSON.stringify(data));
    return data.res?.latex || "";
  }

  async callOpenAI(imageBase64) {
    const model = this.settings.openaiModel || "gpt-4o";
    const detail = this.getEffectiveDetail(model, this.settings.openaiDetail || "high");

    const requestBody = {
      model: model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: this.settings.customPrompt },
            { type: "image_url", image_url: { url: "data:image/png;base64," + imageBase64, detail: detail } },
          ],
        },
      ],
      max_completion_tokens: 2048,
    };

    // 推理模型 (o1, o3, o4 系列) 不支持 temperature 参数
    if (!this.isReasoningModel(model)) {
      requestBody.temperature = 0.1;
    }

    const response = await requestUrl({
      url: this.settings.apiEndpoint || "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + this.settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    if (response.status !== 200) throw this.parseApiError(response, "OpenAI API error");
    const data = response.json;
    const message = data.choices?.[0]?.message;
    if (message?.refusal) {
      throw new Error("OpenAI model refused: " + message.refusal);
    }
    return message?.content || "";
  }

  async callCustomAPI(imageBase64) {
    const response = await requestUrl({
      url: this.settings.apiEndpoint,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + this.settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: "data:image/png;base64," + imageBase64,
        prompt: this.settings.customPrompt,
      }),
    });
    if (response.status !== 200) throw this.parseApiError(response, "Custom API error");
    const data = response.json;
    const customField = this.settings.customResponseField;
    return (customField && data[customField]) || data.latex || data.result || data.text || "";
  }

  async callCustomFormAPI(imageBase64) {
    const blob = this.base64ToBlob(imageBase64);
    const arrayBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
    const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
    const encoder = new TextEncoder();
    const appendString = (buffer, str) => {
      const encoded = encoder.encode(str + "\r\n");
      const newBuffer = new Uint8Array(buffer.length + encoded.length);
      newBuffer.set(buffer);
      newBuffer.set(encoded, buffer.length);
      return newBuffer;
    };
    const appendBytes = (buffer, bytes) => {
      const newBuffer = new Uint8Array(buffer.length + bytes.length);
      newBuffer.set(buffer);
      newBuffer.set(bytes, buffer.length);
      return newBuffer;
    };
    let body = new Uint8Array(0);

    // Append additional form fields before the image (legacy custom-form mode)
    const formFields = this.settings.customFormFields || [];
    if (formFields && Array.isArray(formFields)) {
      for (const field of formFields) {
        if (field.name) {
          let fieldValue = field.value || '';
          fieldValue = this.resolvePlaceholders(fieldValue, imageBase64);
          body = appendString(body, "--" + boundary);
          body = appendString(body, 'Content-Disposition: form-data; name="' + field.name + '"');
          body = appendString(body, "");
          body = appendString(body, fieldValue);
        }
      }
    }

    body = appendString(body, "--" + boundary);
    body = appendString(body, 'Content-Disposition: form-data; name="' + this.settings.customImageFieldName + '"; filename="formula.png"');
    body = appendString(body, "Content-Type: image/png");
    body = appendString(body, "");
    const fileBytes = new Uint8Array(arrayBuffer);
    body = appendBytes(body, fileBytes);
    body = appendString(body, "");
    body = appendString(body, "--" + boundary + "--");

    const headers = {
      "Content-Type": "multipart/form-data; boundary=" + boundary,
    };
    if (this.settings.customApiKeyHeader) {
      headers[this.settings.customApiKeyHeader] = this.settings.apiKey;
    }

    const response = await requestUrl({
      url: this.settings.apiEndpoint,
      method: "POST",
      headers: headers,
      body: body.buffer,
    });
    if (response.status !== 200) throw this.parseApiError(response, "Custom Form API error");
    const data = response.json;
    return data[this.settings.customResponseField] || "";
  }

  // ==================== Custom Provider API ====================
  getCustomProviderConfig(providerId) {
    const providers = this.settings.customProviders || [];
    return providers.find(p => p.id === providerId);
  }

  resolvePlaceholders(str, imageBase64) {
    // Built-in placeholders
    const now = new Date();
    const builtins = {
      image_base64: imageBase64 || '',
      image: 'data:image/png;base64,' + (imageBase64 || ''),
      prompt: this.settings.customPrompt || '',
      apiKey: this.settings.apiKey || '',
      timestamp: String(Math.floor(now.getTime() / 1000)),
      datetime: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      time: now.toTimeString().slice(0, 8),
      random: Math.random().toString(16).slice(2, 10),
    };

    let result = str;
    // Replace built-in placeholders using split/join (avoids regex escaping issues)
    for (const [key, val] of Object.entries(builtins)) {
      result = result.split('{{' + key + '}}').join(val);
    }

    // Replace custom placeholders defined in settings
    const customPlaceholders = this.settings.customPlaceholders || [];
    for (const ph of customPlaceholders) {
      if (ph.name) {
        result = result.split('{{' + ph.name + '}}').join(ph.value || '');
      }
    }

    return result;
  }

  // Safe JSON template resolution: parses template as JSON, recursively
  // walks the structure, replaces placeholders in string values, and
  // re-serializes via JSON.stringify. This prevents JSON injection when
  // placeholder values contain quotes, backslashes, or control characters.
  resolveJSONTemplate(template, imageBase64) {
    let obj;
    try {
      obj = JSON.parse(template);
    } catch (e) {
      console.warn('Body template is not valid JSON, falling back to string substitution:', e);
      return this.resolvePlaceholders(template, imageBase64);
    }
    const walk = (node) => {
      if (typeof node === 'string') {
        return this.resolvePlaceholders(node, imageBase64);
      }
      if (Array.isArray(node)) {
        return node.map(walk);
      }
      if (typeof node === 'object' && node !== null) {
        const result = {};
        for (const [k, v] of Object.entries(node)) {
          result[k] = walk(v);
        }
        return result;
      }
      return node;
    };
    const resolved = walk(obj);
    return JSON.stringify(resolved);
  }

  // Kept for backward compatibility — delegates to resolvePlaceholders
  substituteTemplate(template, imageBase64) {
    return this.resolvePlaceholders(template, imageBase64);
  }
resolvePath(obj, path) {
    path = path.replace(/^\$\./, '');
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null) return '';
      const arrayMatch = part.match(/^(.+?)\[(\d+)\]$/);
      if (arrayMatch) {
        current = current[arrayMatch[1]];
        if (current == null) return '';
        current = current[parseInt(arrayMatch[2])];
      } else {
        if (Array.isArray(current) && /^\d+$/.test(part)) {
          current = current[parseInt(part)];
        } else {
          current = current[part];
        }
      }
    }
    return current != null ? String(current) : '';
  }

  async buildFormDataBody(imageBase64, fieldName, boundary, formFields) {
    const blob = this.base64ToBlob(imageBase64);
    const arrayBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
    const encoder = new TextEncoder();
    const appendString = (buffer, str) => {
      const encoded = encoder.encode(str + "\r\n");
      const newBuf = new Uint8Array(buffer.length + encoded.length);
      newBuf.set(buffer);
      newBuf.set(encoded, buffer.length);
      return newBuf;
    };
    const appendBytes = (buffer, bytes) => {
      const newBuf = new Uint8Array(buffer.length + bytes.length);
      newBuf.set(buffer);
      newBuf.set(bytes, buffer.length);
      return newBuf;
    };
    let body = new Uint8Array(0);

    // Append additional form fields first (before the image)
    if (formFields && Array.isArray(formFields)) {
      for (const field of formFields) {
        if (field.name) {
          let fieldValue = field.value || '';
          fieldValue = this.resolvePlaceholders(fieldValue, imageBase64);
          body = appendString(body, "--" + boundary);
          body = appendString(body, 'Content-Disposition: form-data; name="' + field.name + '"');
          body = appendString(body, "");
          body = appendString(body, fieldValue);
        }
      }
    }

    body = appendString(body, "--" + boundary);
    body = appendString(body, 'Content-Disposition: form-data; name="' + fieldName + '"; filename="formula.png"');
    body = appendString(body, "Content-Type: image/png");
    body = appendString(body, "");
    const fileBytes = new Uint8Array(arrayBuffer);
    body = appendBytes(body, fileBytes);
    body = appendString(body, "");
    body = appendString(body, "--" + boundary + "--");
    return body;
  }

  async callCustomProvider(imageBase64) {
    const config = this.getCustomProviderConfig(this.settings.apiProvider);
    if (!config) throw new Error("Custom provider configuration not found: " + this.settings.apiProvider);

    let url = config.url || '';
    url = this.resolvePlaceholders(url, imageBase64);

    const headers = {};
    const configHeaders = config.headers || [];
    for (const h of configHeaders) {
      if (h.key) {
        let value = h.value || '';
        value = this.resolvePlaceholders(value, imageBase64);
        headers[h.key] = value;
      }
    }

    const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType) {
      if (config.bodyType === 'json') {
        headers['Content-Type'] = 'application/json';
      }
    }

    let body = undefined;
    const method = config.method || 'POST';

    if (method === 'GET' || method === 'DELETE') {
      // No body
    } else if (config.bodyType === 'json') {
      const template = config.bodyTemplate || '{}';
      body = this.resolveJSONTemplate(template, imageBase64);
    } else if (config.bodyType === 'raw') {
      body = this.substituteTemplate(config.bodyTemplate || '', imageBase64);
    } else if (config.bodyType === 'form-data') {
      const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
      // Merge formFields array with key-value pairs extracted from bodyTemplate (if present)
      let mergedFormFields = config.formFields ? [...config.formFields] : [];
      if (config.bodyTemplate) {
        try {
          const templateFields = JSON.parse(config.bodyTemplate);
          for (const [key, value] of Object.entries(templateFields)) {
            const imageFieldName = config.formFieldName || 'image';
            if (!mergedFormFields.some(f => f.name === key) && key !== imageFieldName) {
              const strValue = (typeof value === 'object' && value !== null)
                ? JSON.stringify(value)
                : String(value);
              mergedFormFields.push({ name: key, value: strValue });
            }
          }
        } catch (e) {
          console.warn('Form-data bodyTemplate is not valid JSON, using formFields only:', e);
        }
      }
      const formBody = await this.buildFormDataBody(imageBase64, config.formFieldName || 'image', boundary, mergedFormFields);
      const hasFormContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
      if (!hasFormContentType) {
        headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
      }
      body = formBody.buffer;
    }

    const requestOptions = {
      url: url,
      method: method,
      headers: headers,
    };
    if (body !== undefined) {
      requestOptions.body = body;
    }

    const response = await requestUrl(requestOptions);

    if (response.status < 200 || response.status >= 300) {
      let errorMsg = response.text || ("HTTP " + response.status);
      if (config.errorPath && response.json) {
        try {
          const errData = response.json;
          const extracted = this.resolvePath(errData, config.errorPath);
          if (extracted) errorMsg = extracted;
        } catch (e) {}
      } else {
        try {
          const errData = JSON.parse(response.text);
          errorMsg = errData.error?.message || errData.error?.description || errData.message || errData.detail || response.text;
        } catch (e) {}
      }
      throw new Error("Custom API error (HTTP " + response.status + "): " + errorMsg);
    }

    if (config.responseType === 'regex') {
      const regex = new RegExp(config.responseRegex || '(.*)', 's');
      const match = (response.text || '').match(regex);
      return match ? (match[1] !== undefined ? match[1] : match[0]) : '';
    } else {
      const data = response.json;
      return this.resolvePath(data, config.responsePath || '');
    }
  }
  base64ToBlob(base64, mimeType = "image/png") {
    const byteString = atob(base64);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeType });
  }

  cleanLatex(latex) {
    latex = latex.replace(/```latex/g, "").replace(/```/g, "").trim();
    let changed = true;
    while (changed) {
      changed = false;
      const trimmed = latex.trim();
      if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length > 4) {
        latex = trimmed.slice(2, -2).trim();
        changed = true;
      } else if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length > 2) {
        latex = trimmed.slice(1, -1).trim();
        changed = true;
      } else if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)") && trimmed.length > 4) {
        latex = trimmed.slice(2, -2).trim();
        changed = true;
      } else if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]") && trimmed.length > 4) {
        latex = trimmed.slice(2, -2).trim();
        changed = true;
      } else {
        latex = trimmed;
      }
    }
    return latex;
  }

  // ==================== 结果面板展开/收起 ====================
  toggleResultPanel() {
    const panel = this.contentEl.querySelector(".result-panel");
    if (!panel) return;
    this.resultExpanded = !this.resultExpanded;
    panel.toggleClass("expanded", this.resultExpanded);
    if (this.resultExpanded) {
      // 展开：优先使用用户拖拽的高度，否则用默认 45vh
      if (this.resultUserHeight && this.resultUserHeight > 60) {
        panel.style.maxHeight = this.resultUserHeight + "px";
      } else {
        panel.style.maxHeight = "";
      }
    } else {
      // 收起：清除自定义高度
      panel.style.maxHeight = "";
    }
  }

  // ==================== 结果面板拖拽（移动端高度调整） ====================
  bindResultPanelDrag(handle, panel) {
    let isDragging = false;
    let dragStartY = 0;
    let dragStartHeight = 0;
    let hasMoved = false;
    const DRAG_THRESHOLD = 5;

    const onStart = (clientY) => {
      isDragging = true;
      hasMoved = false;
      dragStartY = clientY;
      const rect = panel.getBoundingClientRect();
      dragStartHeight = rect.height;
      handle.style.cursor = "grabbing";
      panel.style.transition = "none";
    };

    const onMove = (clientY) => {
      if (!isDragging) return;
      const dy = dragStartY - clientY;
      if (Math.abs(dy) > DRAG_THRESHOLD) hasMoved = true;
      if (!hasMoved) return;

      const newHeight = Math.max(36, Math.min(window.innerHeight * 0.85, dragStartHeight + dy));
      panel.style.maxHeight = newHeight + "px";
      if (newHeight > 60) {
        panel.classList.add("expanded");
        this.resultExpanded = true;
      } else {
        panel.classList.remove("expanded");
        this.resultExpanded = false;
      }
    };

    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      handle.style.cursor = "";
      // 延迟恢复 transition，避免弹回动画
      requestAnimationFrame(() => {
        panel.style.transition = "";
      });
      if (hasMoved) {
        // 标记已拖拽，阻止 click 事件触发 toggle
        handle.setAttribute("data-dragged", "true");
        const rect = panel.getBoundingClientRect();
        this.resultUserHeight = rect.height;
      }
    };

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onStart(e.clientY);
    });
    document.addEventListener("mousemove", (e) => {
      if (isDragging) {
        e.preventDefault();
        onMove(e.clientY);
      }
    });
    document.addEventListener("mouseup", onEnd);

    let pendingDragY = null;

    handle.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        // Don't preventDefault so click event can fire for tap-to-toggle
        pendingDragY = e.touches[0].clientY;
        dragStartY = e.touches[0].clientY;
        hasMoved = false;
      }
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (pendingDragY !== null && e.touches.length === 1) {
        const dy = pendingDragY - e.touches[0].clientY;
        if (Math.abs(dy) > DRAG_THRESHOLD) {
          if (!isDragging) {
            e.preventDefault();
            onStart(pendingDragY);
            pendingDragY = null;
          }
        }
      }
      if (isDragging && e.touches.length === 1) {
        e.preventDefault();
        onMove(e.touches[0].clientY);
      }
    }, { passive: false });

    document.addEventListener("touchend", (e) => {
      pendingDragY = null;
      onEnd();
    });
    document.addEventListener("touchcancel", (e) => {
      pendingDragY = null;
      onEnd();
    });
  }

  // ==================== 历史记录（持久化到 plugin 实例） ====================
  updateHistoryUI() {
    const idx = this.plugin.historyIndex;
    const len = this.plugin.history.length;
    if (this.prevHistoryBtn) {
      this.prevHistoryBtn.toggleClass("disabled", idx <= 0);
    }
    if (this.nextHistoryBtn) {
      this.nextHistoryBtn.toggleClass("disabled", idx >= len - 1);
    }
    if (this.historyCounter) {
      this.historyCounter.setText(len > 0 ? `${idx + 1}/${len}` : "0/0");
    }
  }

  navigateHistory(delta) {
    const newIndex = this.plugin.historyIndex + delta;
    if (newIndex < 0 || newIndex >= this.plugin.history.length) return;
    this.plugin.historyIndex = newIndex;
    const latex = this.plugin.history[newIndex];
    this.resultEl.setText(latex || "(No result yet)");
    this.resultEl.setAttr("data-latex", latex || "");
    this.statusEl.setText(`History: ${newIndex + 1}/${this.plugin.history.length}`);
    this.updateHistoryUI();
  }

  saveToHistory(latex) {
    if (!latex) return;
    const maxSize = this.settings.maxHistorySize ?? 30;
    if (maxSize === 0) return;
    // 如果当前不在历史末尾，截断后面的记录
    if (this.plugin.historyIndex < this.plugin.history.length - 1) {
      this.plugin.history = this.plugin.history.slice(0, this.plugin.historyIndex + 1);
    }
    this.plugin.history.push(latex);
    // 限制长度
    if (this.plugin.history.length > maxSize) {
      this.plugin.history.shift();
    } else {
      this.plugin.historyIndex++;
    }
    this.updateHistoryUI();
  }

  insertAndClose() {
    const latex = this.resultEl.getAttr("data-latex");
    if (!latex) {
      new Notice("No LaTeX to insert. Please recognize first.");
      return;
    }

    let textToInsert;
    if (this.mathMode === "inline") {
      textToInsert = "$" + latex + "$";
    } else if (this.mathMode === "display") {
      textToInsert = "$$" + latex + "$$";
    } else {
      textToInsert = latex;
    }

    const cursor = this.editor.getCursor();
    this.editor.replaceRange(textToInsert, cursor);
    const newCursor = { line: cursor.line, ch: cursor.ch + textToInsert.length };
    this.editor.setCursor(newCursor);
    new Notice("LaTeX inserted!");
    this.close();
  }

  onClose() {
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(t => t.stop());
      this.currentStream = null;
    }
    this.cropperImageScale = 1;
    this.cropperImageOffsetX = 0;
    this.cropperImageOffsetY = 0;
    this.cropperSelectionData = null;
    if (this._cleanupResize) this._cleanupResize();
    if (this._toolbarResizeObserver) { this._toolbarResizeObserver.disconnect(); this._toolbarResizeObserver = null; }
    if (this.isFullscreen) this.exitFullscreen();
    this.contentEl.empty();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.style.overflow = "";
  }
}

class HandwritingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._expandedProviders = new Set();
  }

  display() {
    const containerEl = this.containerEl;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Handwriting to LaTeX Settings" });

    // ========== API Provider dropdown (built-in + custom) ==========
    const providerOptions = {
      "simpletex": "SimpleTex (Recommended)",
      "mathpix": "Mathpix",
      "openai": "OpenAI GPT-4o Vision",
    };
    providerOptions["custom"] = "Custom API (JSON) [Legacy]";
    providerOptions["custom-form"] = "Custom API (Multipart Form) [Legacy]";
    const customProviders = this.plugin.settings.customProviders || [];
    for (const cp of customProviders) {
      providerOptions[cp.id] = "\uD83D\uDD27 " + cp.name;
    }

    new Setting(containerEl)
      .setName("API Provider")
      .setDesc("Choose which service to use for formula recognition. Custom providers are listed with \uD83D\uDD27 prefix.")
      .addDropdown((dropdown) => {
        for (const [key, label] of Object.entries(providerOptions)) {
          dropdown.addOption(key, label);
        }
        dropdown.setValue(this.plugin.settings.apiProvider);
        dropdown.onChange(async (value) => {
          this.plugin.settings.apiProvider = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("For SimpleTex: use UAT token. For Mathpix: App Key. For OpenAI: API key. For custom providers, this populates the {{apiKey}} placeholder.")
      .addText((text) => text.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => { this.plugin.settings.apiKey = value; await this.plugin.saveSettings(); })
      );

    if (this.plugin.settings.apiProvider === "mathpix") {
      new Setting(containerEl)
        .setName("Mathpix App ID")
        .setDesc("Your Mathpix App ID (required for Mathpix). Get it from https://mathpix.com/")
        .addText((text) => text.setPlaceholder("your_app_id").setValue(this.plugin.settings.mathpixAppId)
          .onChange(async (value) => { this.plugin.settings.mathpixAppId = value; await this.plugin.saveSettings(); })
        );
    }

    if (this.plugin.settings.apiProvider === "custom" || this.plugin.settings.apiProvider === "openai" || this.plugin.settings.apiProvider === "custom-form") {
      new Setting(containerEl)
        .setName("API Endpoint")
        .setDesc("Custom API endpoint URL (optional for OpenAI)")
        .addText((text) => text.setPlaceholder("https://api.example.com/recognize").setValue(this.plugin.settings.apiEndpoint)
          .onChange(async (value) => { this.plugin.settings.apiEndpoint = value; await this.plugin.saveSettings(); })
        );
    }

    if (this.plugin.settings.apiProvider === "openai") {
      new Setting(containerEl)
        .setName("OpenAI Model")
        .setDesc("Model name for OpenAI vision API (e.g. gpt-4o, gpt-4o-mini, gpt-4.1)")
        .addText((text) => text.setPlaceholder("gpt-4o").setValue(this.plugin.settings.openaiModel)
          .onChange(async (value) => { this.plugin.settings.openaiModel = value; await this.plugin.saveSettings(); })
        );

      new Setting(containerEl)
        .setName("Vision Detail Level")
        .setDesc("Image detail level: low (faster/cheaper), high (better accuracy), auto (default). NOTE: original requires gpt-5.4+ and will auto-fallback to high on older models.")
        .addDropdown((dropdown) => dropdown
          .addOption("low", "low")
          .addOption("high", "high")
          .addOption("auto", "auto")
          .addOption("original", "original (GPT-5.4+)")
          .setValue(this.plugin.settings.openaiDetail || "high")
          .onChange(async (value) => { this.plugin.settings.openaiDetail = value; await this.plugin.saveSettings(); })
        );
    }

    if (this.plugin.settings.apiProvider === "openai" || this.plugin.settings.apiProvider === "custom") {
      new Setting(containerEl)
        .setName("Custom Prompt")
        .setDesc("Prompt sent to AI for recognition. Also available as {{prompt}} placeholder in custom provider body templates.")
        .addTextArea((text) => text.setValue(this.plugin.settings.customPrompt)
          .onChange(async (value) => { this.plugin.settings.customPrompt = value; await this.plugin.saveSettings(); })
        );
    }

    if (this.plugin.settings.apiProvider === "custom-form") {
      new Setting(containerEl)
        .setName("Response Field Name")
        .setDesc("The JSON field name containing the LaTeX result (e.g. 'text', 'latex', 'result')")
        .addText((text) => text.setPlaceholder("text").setValue(this.plugin.settings.customResponseField)
          .onChange(async (value) => { this.plugin.settings.customResponseField = value; await this.plugin.saveSettings(); })
        );

      new Setting(containerEl)
        .setName("API Key Header Name")
        .setDesc("The HTTP header name for the API key (e.g. 'X-API-Key', 'Authorization')")
        .addText((text) => text.setPlaceholder("X-API-Key").setValue(this.plugin.settings.customApiKeyHeader)
          .onChange(async (value) => { this.plugin.settings.customApiKeyHeader = value; await this.plugin.saveSettings(); })
        );

      new Setting(containerEl)
        .setName("Image Field Name")
        .setDesc("The form field name for the uploaded image (e.g. 'image', 'file')")
        .addText((text) => text.setPlaceholder("image").setValue(this.plugin.settings.customImageFieldName)
          .onChange(async (value) => { this.plugin.settings.customImageFieldName = value; await this.plugin.saveSettings(); })
        );
      // Additional form fields for legacy custom-form mode
      const legacyFormFieldsSection = containerEl.createDiv({ cls: "provider-formfields-section" });
      legacyFormFieldsSection.createEl("h4", { text: "Additional Form Fields" });
      legacyFormFieldsSection.createEl("p", { text: "Add extra form-data fields (e.g. prompt, model). Values support {{prompt}}, {{apiKey}}, {{image_base64}}, {{image}} placeholders.", cls: "setting-item-description" });
      
      const legacyFormFieldsList = legacyFormFieldsSection.createDiv({ cls: "provider-formfields-list" });
      const renderLegacyFormFields = () => {
        legacyFormFieldsList.empty();
        const fields = this.plugin.settings.customFormFields || [];
        for (let fi = 0; fi < fields.length; fi++) {
          const field = fields[fi];
          const row = legacyFormFieldsList.createDiv({ cls: "provider-header-row" });
          row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;";
          
          const nameInput = row.createEl("input", { type: "text", placeholder: "Field Name", value: field.name || "" });
          nameInput.style.cssText = "flex:1;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);";
          nameInput.addEventListener("input", async () => { field.name = nameInput.value; await this.plugin.saveSettings(); });
          
          const valueInput = row.createEl("input", { type: "text", placeholder: "Field Value", value: field.value || "" });
          valueInput.style.cssText = "flex:2;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);font-family:monospace;";
          valueInput.addEventListener("input", async () => { field.value = valueInput.value; await this.plugin.saveSettings(); });
          
          const removeBtn = row.createEl("button", { text: "\u2715", attr: { "aria-label": "Remove field" } });
          removeBtn.style.cssText = "padding:2px 8px;font-size:12px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);color:var(--text-error);flex-shrink:0;";
          removeBtn.addEventListener("click", async () => { fields.splice(fi, 1); await this.plugin.saveSettings(); renderLegacyFormFields(); });
        }
        
        const addRow = legacyFormFieldsList.createDiv({ cls: "provider-header-row" });
        const addBtn = addRow.createEl("button", { text: "+ Add Form Field" });
        addBtn.style.cssText = "padding:4px 12px;font-size:11px;cursor:pointer;border:1px dashed var(--background-modifier-border);border-radius:4px;background:transparent;";
        addBtn.addEventListener("click", async () => {
          if (!this.plugin.settings.customFormFields) this.plugin.settings.customFormFields = [];
          this.plugin.settings.customFormFields.push({ name: "", value: "" });
          await this.plugin.saveSettings();
          renderLegacyFormFields();
        });
      };
      renderLegacyFormFields();
    }

    new Setting(containerEl)
      .setName("Math Insert Mode")
      .setDesc("How to wrap the recognized LaTeX when inserting")
      .addDropdown((dropdown) => dropdown
        .addOption("inline", "Inline ($...$)")
        .addOption("display", "Display ($$...$$)")
        .addOption("raw", "Raw (no $)")
        .setValue(this.plugin.settings.mathMode || "inline")
        .onChange(async (value) => { this.plugin.settings.mathMode = value; await this.plugin.saveSettings(); })
      );

    containerEl.createEl("h3", { text: "Canvas Settings" });

    new Setting(containerEl)
      .setName("Show Grid")
      .setDesc("Display background grid on canvas")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showGrid !== false)
        .onChange(async (value) => { this.plugin.settings.showGrid = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Stroke Color")
      .setDesc("Color of the handwriting pen")
      .addColorPicker((picker) => picker.setValue(this.plugin.settings.strokeColor)
        .onChange(async (value) => { this.plugin.settings.strokeColor = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Stroke Width")
      .setDesc("Width of the pen stroke")
      .addSlider((slider) => slider.setLimits(1, 10, 1).setValue(this.plugin.settings.strokeWidth).setDynamicTooltip()
        .onChange(async (value) => { this.plugin.settings.strokeWidth = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Default Canvas Width")
      .setDesc("Default width of the handwriting canvas in pixels")
      .addSlider((slider) => slider.setLimits(400, 2000, 100).setValue(this.plugin.settings.canvasWidth)
        .onChange(async (value) => { this.plugin.settings.canvasWidth = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Default Canvas Height")
      .setDesc("Default height of the handwriting canvas in pixels")
      .addSlider((slider) => slider.setLimits(300, 1200, 100).setValue(this.plugin.settings.canvasHeight)
        .onChange(async (value) => { this.plugin.settings.canvasHeight = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Max History Size")
      .setDesc("Maximum number of recognition results to keep in history (0 to disable)")
      .addSlider((slider) => slider.setLimits(0, 100, 5).setValue(this.plugin.settings.maxHistorySize ?? 30).setDynamicTooltip()
        .onChange(async (value) => { this.plugin.settings.maxHistorySize = value; await this.plugin.saveSettings(); })
      );

    // ========== Custom API Providers Management ==========
    containerEl.createEl("h3", { text: "\uD83D\uDD27 Custom API Providers" });
    
    const customDesc = containerEl.createDiv({ cls: "setting-item-description" });
    customDesc.innerHTML = `
      <p>Define your own API endpoints for formula recognition. Each provider supports:</p>
      <ul>
        <li><strong>Name:</strong> Display name shown in the provider dropdown</li>
        <li><strong>Method:</strong> GET, POST, PUT, DELETE, PATCH</li>
        <li><strong>URL:</strong> API endpoint (supports <code>{{apiKey}}</code> placeholder)</li>
        <li><strong>Headers:</strong> Key-value pairs (values support <code>{{apiKey}}</code> placeholder)</li>
        <li><strong>Body Type:</strong> JSON, Form-Data (multipart), or Raw text</li>
        <li><strong>Body Template:</strong> For JSON/Raw, use placeholders: <code>{{image_base64}}</code> (raw base64), <code>{{image}}</code> (full data URL), <code>{{prompt}}</code>, <code>{{apiKey}}</code>, <code>{{timestamp}}</code>, <code>{{datetime}}</code>, <code>{{date}}</code>, <code>{{time}}</code>, <code>{{random}}</code>, or any custom placeholder defined in "Custom Placeholders" below.</li>
        <li><strong>Response Path:</strong> Dot-path (e.g. <code>data.latex</code>) or JSONPath (e.g. <code>$.choices.0.message.content</code>) to extract LaTeX from JSON response</li>
        <li><strong>Regex:</strong> For non-JSON responses, a regex with a capture group to extract LaTeX</li>
      </ul>
    `;

    // Preset templates
    const presetsDiv = containerEl.createDiv({ cls: "custom-providers-presets" });
    presetsDiv.createEl("h4", { text: "\uD83D\DCCB Import Preset Template" });
    
    const presetButtons = presetsDiv.createDiv({ cls: "preset-buttons" });
    presetButtons.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;";
    
    const importPreset = async (preset) => {
      const providers = this.plugin.settings.customProviders || [];
      // Check for existing providers with the same name to avoid duplicates
      const existingNames = providers.map(p => p.name);
      let presetName = preset.name;
      if (existingNames.includes(presetName)) {
        let suffix = 2;
        while (existingNames.includes(presetName + " (" + suffix + ")")) {
          suffix++;
        }
        presetName = presetName + " (" + suffix + ")";
      }
      const id = "custom_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
      const presetClone = JSON.parse(JSON.stringify(preset));
      presetClone.name = presetName;
      providers.push({ id, ...presetClone });
      this.plugin.settings.customProviders = providers;
      await this.plugin.saveSettings();
      this.display();
      new Notice(`Preset "${presetName}" imported!`);
    };

    for (const preset of PRESET_TEMPLATES) {
      const btn = presetButtons.createEl("button", { text: "\uD83D\DCE5 " + preset.name, cls: "preset-import-btn" });
      btn.style.cssText = "padding:6px 12px;font-size:12px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-secondary);";
      btn.addEventListener("click", () => importPreset(preset));
    }

    const listContainer = containerEl.createDiv({ cls: "custom-providers-list" });
    this.renderCustomProvidersList(listContainer);

    new Setting(containerEl)
      .setName("Add New Provider")
      .setDesc("Create a custom API provider configuration")
      .addButton((btn) => btn.setButtonText("\u2795 Add Provider").setCta().onClick(async () => {
        const providers = this.plugin.settings.customProviders || [];
        const id = "custom_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
        providers.push({
          id,
          name: "New Provider",
          method: "POST",
          url: "https://api.example.com/recognize",
          headers: [
            { key: "Authorization", value: "Bearer {{apiKey}}" },
            { key: "Content-Type", value: "application/json" }
          ],
          bodyType: "json",
          bodyTemplate: '{"image": "{{image}}", "prompt": "{{prompt}}"}',
          formFieldName: "image",
          formFields: [],
          responsePath: "data.latex",
          responseType: "json",
          responseRegex: "",
          errorPath: ""
        });
        this.plugin.settings.customProviders = providers;
        await this.plugin.saveSettings();
        this.display();
        new Notice("New provider added! Configure it below.");
      }));

    // ========== Custom Placeholders ==========
    containerEl.createEl("h3", { text: "🔖 Custom Placeholders" });
    
    const placeholdersDesc = containerEl.createDiv({ cls: "setting-item-description" });
    placeholdersDesc.innerHTML = `
      <p>Define custom placeholders that can be used in body templates, form field values, URLs, and headers. Built-in placeholders are always available:</p>
      <ul>
        <li><code>{{image_base64}}</code> — raw base64 image data</li>
        <li><code>{{image}}</code> — full data URL (data:image/png;base64,...)</li>
        <li><code>{{prompt}}</code> — custom prompt text</li>
        <li><code>{{apiKey}}</code> — API key from settings</li>
        <li><code>{{timestamp}}</code> — current Unix timestamp (seconds)</li>
        <li><code>{{datetime}}</code> — current ISO 8601 datetime</li>
        <li><code>{{date}}</code> — current date (YYYY-MM-DD)</li>
        <li><code>{{time}}</code> — current time (HH:mm:ss)</li>
        <li><code>{{random}}</code> — random 8-character hex string</li>
      </ul>
    `;

    const phListContainer = containerEl.createDiv({ cls: "custom-placeholders-list" });
    
    const renderPlaceholders = () => {
      phListContainer.empty();
      const placeholders = this.plugin.settings.customPlaceholders || [];
      
      for (let pi = 0; pi < placeholders.length; pi++) {
        const ph = placeholders[pi];
        const row = phListContainer.createDiv({ cls: "provider-header-row" });
        row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;";
        
        const nameInput = row.createEl("input", { type: "text", placeholder: "Name (e.g. model)", value: ph.name || "" });
        nameInput.style.cssText = "flex:1;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);";
        nameInput.addEventListener("input", async () => { ph.name = nameInput.value; await this.plugin.saveSettings(); });
        
        const valueInput = row.createEl("input", { type: "text", placeholder: "Value (e.g. gpt-4o)", value: ph.value || "" });
        valueInput.style.cssText = "flex:2;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);font-family:monospace;";
        valueInput.addEventListener("input", async () => { ph.value = valueInput.value; await this.plugin.saveSettings(); });
        
        const usageHint = row.createEl("span", { text: "{{" + (ph.name || "?") + "}}", cls: "placeholder-usage-hint" });
        usageHint.style.cssText = "flex-shrink:0;font-size:10px;color:var(--text-muted);font-family:monospace;min-width:80px;text-align:right;";
        
        const removeBtn = row.createEl("button", { text: "✕", attr: { "aria-label": "Remove placeholder" } });
        removeBtn.style.cssText = "padding:2px 8px;font-size:12px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);color:var(--text-error);flex-shrink:0;";
        removeBtn.addEventListener("click", async () => { placeholders.splice(pi, 1); await this.plugin.saveSettings(); renderPlaceholders(); });
      }
      
      const addRow = phListContainer.createDiv({ cls: "provider-header-row" });
      const addBtn = addRow.createEl("button", { text: "+ Add Custom Placeholder" });
      addBtn.style.cssText = "padding:4px 12px;font-size:11px;cursor:pointer;border:1px dashed var(--background-modifier-border);border-radius:4px;background:transparent;";
      addBtn.addEventListener("click", async () => {
        if (!this.plugin.settings.customPlaceholders) this.plugin.settings.customPlaceholders = [];
        this.plugin.settings.customPlaceholders.push({ name: "", value: "" });
        await this.plugin.saveSettings();
        renderPlaceholders();
      });
    };
    renderPlaceholders();

    containerEl.createEl("h3", { text: "API Setup Guide" });
    const guide = containerEl.createEl("div");
    guide.innerHTML = `
      <p><strong>SimpleTex (Recommended):</strong> Register at <a href="https://simpletex.cn/">simpletex.cn</a>, go to User Center, create a <strong>UAT (User Authorization Token)</strong> in "User Authorization Token" menu. Paste the token here.</p>
      <p><strong>Mathpix:</strong> Get <strong>App ID</strong> and <strong>App Key</strong> at <a href="https://mathpix.com/">mathpix.com</a>. Paste App ID in "Mathpix App ID" and App Key in "API Key". Most accurate for math formulas.</p>
      <p><strong>OpenAI:</strong> Use your OpenAI API key. Supports gpt-4o, gpt-4o-mini, gpt-4.1, etc. Set "detail" to "high" for best formula recognition accuracy.</p>
      <p><strong>Custom API Providers:</strong> Use the 🔧 Custom API Providers section above to define your own endpoints. Supports JSON, Form-Data, and Raw body types. Available placeholders: <code>{{image_base64}}</code> (raw base64), <code>{{image}}</code> (data URL), <code>{{prompt}}</code>, <code>{{apiKey}}</code>, <code>{{timestamp}}</code>, <code>{{datetime}}</code>, <code>{{date}}</code>, <code>{{time}}</code>, <code>{{random}}</code>, plus any custom placeholders defined above.</p>
      <p><strong>Legacy Custom modes</strong> (Custom JSON / Custom Form) are still available for backward compatibility.</p>
    `;
  }
  renderCustomProvidersList(listContainer) {
    listContainer.empty();
    const providers = this.plugin.settings.customProviders || [];
    
    if (providers.length === 0) {
      listContainer.createEl("p", { text: "No custom providers configured yet. Add one below or import a preset template.", cls: "setting-item-description" });
      return;
    }

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const isExpanded = this._expandedProviders.has(provider.id);
      
      const card = listContainer.createDiv({ cls: "custom-provider-card" });
      card.style.cssText = "border:1px solid var(--background-modifier-border);border-radius:8px;padding:12px;margin-bottom:12px;background:var(--background-secondary);";

      const cardHeader = card.createDiv({ cls: "provider-card-header" });
      cardHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;";
      
      const headerLeft = cardHeader.createDiv({ cls: "provider-header-left" });
      headerLeft.style.cssText = "display:flex;align-items:center;gap:8px;flex:1;min-width:0;";
      
      const expandIcon = headerLeft.createEl("span", { text: isExpanded ? "\u25BC" : "\u25B6", cls: "provider-expand-icon" });
      expandIcon.style.cssText = "font-size:10px;flex-shrink:0;";
      
      const nameEl = headerLeft.createEl("strong", { text: provider.name || "Unnamed Provider" });
      nameEl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      
      const methodBadge = headerLeft.createEl("span", { text: provider.method || "POST", cls: "provider-method-badge" });
      methodBadge.style.cssText = "font-size:10px;padding:2px 6px;border-radius:3px;background:var(--interactive-accent);color:white;flex-shrink:0;";

      const headerActions = cardHeader.createDiv({ cls: "provider-header-actions" });
      headerActions.style.cssText = "display:flex;gap:4px;flex-shrink:0;margin-left:8px;";
      
      const moveUpBtn = headerActions.createEl("button", { text: "\u25B2", attr: { "aria-label": "Move up" } });
      moveUpBtn.style.cssText = "padding:2px 6px;font-size:10px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:3px;background:var(--background-primary);";
      moveUpBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (i === 0) return;
        const list = this.plugin.settings.customProviders;
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        await this.plugin.saveSettings();
        this.display();
      });
      
      const moveDownBtn = headerActions.createEl("button", { text: "\u25BC", attr: { "aria-label": "Move down" } });
      moveDownBtn.style.cssText = "padding:2px 6px;font-size:10px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:3px;background:var(--background-primary);";
      moveDownBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (i === providers.length - 1) return;
        const list = this.plugin.settings.customProviders;
        [list[i], list[i + 1]] = [list[i + 1], list[i]];
        await this.plugin.saveSettings();
        this.display();
      });
      
      const deleteBtn = headerActions.createEl("button", { text: "\uD83D\uDDD1\uFE0F", attr: { "aria-label": "Delete provider" } });
      deleteBtn.style.cssText = "padding:2px 6px;font-size:10px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:3px;background:var(--background-primary);color:var(--text-error);";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Delete provider "${provider.name}"?`)) {
          const list = this.plugin.settings.customProviders;
          list.splice(i, 1);
          if (this.plugin.settings.apiProvider === provider.id) {
            this.plugin.settings.apiProvider = "simpletex";
          }
          this._expandedProviders.delete(provider.id);
          await this.plugin.saveSettings();
          this.display();
          new Notice(`Provider "${provider.name}" deleted.`);
        }
      });

      cardHeader.addEventListener("click", () => {
        if (isExpanded) {
          this._expandedProviders.delete(provider.id);
        } else {
          this._expandedProviders.add(provider.id);
        }
        this.display();
      });

      if (isExpanded) {
        const cardBody = card.createDiv({ cls: "provider-card-body" });
        cardBody.style.cssText = "margin-top:12px;padding-top:12px;border-top:1px solid var(--background-modifier-border);";
        
        new Setting(cardBody)
          .setName("Provider Name")
          .setDesc("Display name shown in the API provider dropdown")
          .addText((text) => text.setPlaceholder("My Custom API").setValue(provider.name || "")
            .onChange(async (value) => { provider.name = value; await this.plugin.saveSettings(); }));

        new Setting(cardBody)
          .setName("Request Method")
          .setDesc("HTTP method for the API request")
          .addDropdown((dropdown) => dropdown
            .addOption("GET", "GET")
            .addOption("POST", "POST")
            .addOption("PUT", "PUT")
            .addOption("DELETE", "DELETE")
            .addOption("PATCH", "PATCH")
            .setValue(provider.method || "POST")
            .onChange(async (value) => { provider.method = value; await this.plugin.saveSettings(); }));

        new Setting(cardBody)
          .setName("Request URL")
          .setDesc("API endpoint URL. Supports {{apiKey}} placeholder which will be replaced with the API Key field value.")
          .addText((text) => text.setPlaceholder("https://api.example.com/recognize").setValue(provider.url || "")
            .onChange(async (value) => { provider.url = value; await this.plugin.saveSettings(); }));

        new Setting(cardBody)
          .setName("Body Type")
          .setDesc("Format of the request body")
          .addDropdown((dropdown) => dropdown
            .addOption("json", "JSON")
            .addOption("form-data", "Form-Data (multipart)")
            .addOption("raw", "Raw Text")
            .setValue(provider.bodyType || "json")
            .onChange(async (value) => { provider.bodyType = value; await this.plugin.saveSettings(); this.display(); }));

        if (provider.bodyType === "form-data") {
          new Setting(cardBody)
            .setName("Image Form Field Name")
            .setDesc("The form field name for the uploaded image (e.g. 'image', 'file')")
            .addText((text) => text.setPlaceholder("image").setValue(provider.formFieldName || "image")
              .onChange(async (value) => { provider.formFieldName = value; await this.plugin.saveSettings(); }));


          // Optional bodyTemplate for form-data: parsed as JSON to auto-generate form fields
          new Setting(cardBody)
            .setName("Body Template (optional)")
            .setDesc("Optional JSON template. Each key becomes a form field (values support {{prompt}}, {{apiKey}}, {{image}}, {{image_base64}}). Merged with Additional Form Fields below.")
            .addTextArea((text) => {
              text.setPlaceholder('{"prompt": "{{prompt}}", "model": "my-model"}');
              text.setValue(provider.bodyTemplate || "");
              text.inputEl.style.cssText = "font-family:monospace;font-size:12px;min-height:60px;";
              text.onChange(async (value) => { provider.bodyTemplate = value; await this.plugin.saveSettings(); });
            });

          // Additional form fields
          const formFieldsSection = cardBody.createDiv({ cls: "provider-formfields-section" });
          formFieldsSection.createEl("h4", { text: "Additional Form Fields" });
          formFieldsSection.createEl("p", { text: "Add extra form-data fields (e.g. prompt, model). Values support {{prompt}}, {{apiKey}} placeholders.", cls: "setting-item-description" });
          
          const formFieldsList = formFieldsSection.createDiv({ cls: "provider-formfields-list" });
          const renderFormFields = () => {
            formFieldsList.empty();
            const fields = provider.formFields || [];
            for (let fi = 0; fi < fields.length; fi++) {
              const field = fields[fi];
              const row = formFieldsList.createDiv({ cls: "provider-header-row" });
              row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;";
              
              const nameInput = row.createEl("input", { type: "text", placeholder: "Field Name", value: field.name || "" });
              nameInput.style.cssText = "flex:1;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);";
              nameInput.addEventListener("input", async () => { field.name = nameInput.value; await this.plugin.saveSettings(); });
              
              const valueInput = row.createEl("input", { type: "text", placeholder: "Field Value", value: field.value || "" });
              valueInput.style.cssText = "flex:2;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);font-family:monospace;";
              valueInput.addEventListener("input", async () => { field.value = valueInput.value; await this.plugin.saveSettings(); });
              
              const removeBtn = row.createEl("button", { text: "\u2715", attr: { "aria-label": "Remove field" } });
              removeBtn.style.cssText = "padding:2px 8px;font-size:12px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);color:var(--text-error);flex-shrink:0;";
              removeBtn.addEventListener("click", async () => { fields.splice(fi, 1); await this.plugin.saveSettings(); renderFormFields(); });
            }
            
            const addRow = formFieldsList.createDiv({ cls: "provider-header-row" });
            const addBtn = addRow.createEl("button", { text: "+ Add Form Field" });
            addBtn.style.cssText = "padding:4px 12px;font-size:11px;cursor:pointer;border:1px dashed var(--background-modifier-border);border-radius:4px;background:transparent;";
            addBtn.addEventListener("click", async () => {
              if (!provider.formFields) provider.formFields = [];
              provider.formFields.push({ name: "", value: "" });
              await this.plugin.saveSettings();
              renderFormFields();
            });
          };
          renderFormFields();
        }
        if (provider.bodyType === "json" || provider.bodyType === "raw") {
          new Setting(cardBody)
            .setName("Body Template")
            .setDesc("Template with placeholders: {{image_base64}} (raw base64), {{image}} (data:image/png;base64,...), {{prompt}} (custom prompt), {{apiKey}} (API key).")
            .addTextArea((text) => {
              text.setPlaceholder('{"image": "{{image}}", "prompt": "{{prompt}}"}');
              text.setValue(provider.bodyTemplate || "");
              text.inputEl.style.cssText = "font-family:monospace;font-size:12px;min-height:100px;";
              text.onChange(async (value) => { provider.bodyTemplate = value; await this.plugin.saveSettings(); });
            });
        }

        const headersSection = cardBody.createDiv({ cls: "provider-headers-section" });
        headersSection.createEl("h4", { text: "Request Headers" });
        headersSection.createEl("p", { text: "Header values support {{apiKey}} placeholder. Content-Type is set automatically for JSON and Form-Data unless overridden.", cls: "setting-item-description" });
        
        const headersList = headersSection.createDiv({ cls: "provider-headers-list" });
        const renderHeaders = () => {
          headersList.empty();
          const headers = provider.headers || [];
          for (let hi = 0; hi < headers.length; hi++) {
            const header = headers[hi];
            const row = headersList.createDiv({ cls: "provider-header-row" });
            row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;";
            
            const keyInput = row.createEl("input", { type: "text", placeholder: "Header Name", value: header.key || "" });
            keyInput.style.cssText = "flex:1;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);";
            keyInput.addEventListener("input", async () => { header.key = keyInput.value; await this.plugin.saveSettings(); });
            
            const valueInput = row.createEl("input", { type: "text", placeholder: "Header Value", value: header.value || "" });
            valueInput.style.cssText = "flex:2;min-width:0;padding:4px 8px;font-size:12px;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);font-family:monospace;";
            valueInput.addEventListener("input", async () => { header.value = valueInput.value; await this.plugin.saveSettings(); });
            
            const removeBtn = row.createEl("button", { text: "\u2715", attr: { "aria-label": "Remove header" } });
            removeBtn.style.cssText = "padding:2px 8px;font-size:12px;cursor:pointer;border:1px solid var(--background-modifier-border);border-radius:4px;background:var(--background-primary);color:var(--text-error);flex-shrink:0;";
            removeBtn.addEventListener("click", async () => { headers.splice(hi, 1); await this.plugin.saveSettings(); renderHeaders(); });
          }
          
          const addRow = headersList.createDiv({ cls: "provider-header-row" });
          const addBtn = addRow.createEl("button", { text: "+ Add Header" });
          addBtn.style.cssText = "padding:4px 12px;font-size:11px;cursor:pointer;border:1px dashed var(--background-modifier-border);border-radius:4px;background:transparent;";
          addBtn.addEventListener("click", async () => {
            if (!provider.headers) provider.headers = [];
            provider.headers.push({ key: "", value: "" });
            await this.plugin.saveSettings();
            renderHeaders();
          });
        };
        renderHeaders();

        new Setting(cardBody)
          .setName("Response Type")
          .setDesc("How to parse the API response")
          .addDropdown((dropdown) => dropdown
            .addOption("json", "JSON (use path below)")
            .addOption("regex", "Text (use regex below)")
            .setValue(provider.responseType || "json")
            .onChange(async (value) => { provider.responseType = value; await this.plugin.saveSettings(); this.display(); }));

        if (provider.responseType === "json") {
          new Setting(cardBody)
            .setName("Response JSON Path")
            .setDesc("Dot-path (e.g. data.latex) or JSONPath (e.g. $.choices.0.message.content). Supports array index like items.0.name.")
            .addText((text) => text.setPlaceholder("data.latex").setValue(provider.responsePath || "")
              .onChange(async (value) => { provider.responsePath = value; await this.plugin.saveSettings(); }));
        }

        if (provider.responseType === "regex") {
          new Setting(cardBody)
            .setName("Response Regex")
            .setDesc("Regular expression with a capture group to extract LaTeX. The first capture group is used, or the full match if no group.")
            .addText((text) => {
              text.setPlaceholder("\\\\begin\\{document\\}([\\\\s\\\\S]*?)\\\\end\\{document\\}");
              text.setValue(provider.responseRegex || "");
              text.inputEl.style.cssText = "font-family:monospace;font-size:12px;";
              text.onChange(async (value) => { provider.responseRegex = value; await this.plugin.saveSettings(); });
            });
        }

        new Setting(cardBody)
          .setName("Error Path (optional)")
          .setDesc("Dot-path to extract error message from error responses (e.g. error.message). Leave blank for default error handling.")
          .addText((text) => text.setPlaceholder("error.message").setValue(provider.errorPath || "")
            .onChange(async (value) => { provider.errorPath = value; await this.plugin.saveSettings(); }));

        new Setting(cardBody)
          .setName("Duplicate Provider")
          .setDesc("Create a copy of this provider configuration")
          .addButton((btn) => btn.setButtonText("\uD83D\DCCB Duplicate").onClick(async () => {
            const list = this.plugin.settings.customProviders;
            const clone = JSON.parse(JSON.stringify(provider));
            clone.id = "custom_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
            clone.name = (clone.name || "Provider") + " (Copy)";
            list.splice(i + 1, 0, clone);
            await this.plugin.saveSettings();
            this.display();
            new Notice(`Provider "${clone.name}" duplicated.`);
          }));
      }
    }
  }
}

module.exports = HandwritingLatexPlugin;
