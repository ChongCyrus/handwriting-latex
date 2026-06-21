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
};

class HandwritingLatexPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "open-handwriting-canvas",
      name: "Open handwriting canvas",
      editorCallback: (editor) => {
        new HandwritingModal(this.app, this.settings, editor).open();
      },
    });

    this.addRibbonIcon("pencil", "Handwriting to LaTeX", () => {
      const activeView = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
      if (activeView) {
        new HandwritingModal(this.app, this.settings, activeView.editor).open();
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
  constructor(app, settings, editor) {
    super(app);
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
    canvasWrapper.style.width = this.settings.canvasWidth + "px";
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

    resultContent.createEl("h3", { text: "Preview:" });
    this.resultEl = resultContent.createDiv({ cls: "latex-preview" });
    this.resultEl.setText("(No result yet)");

    let resultExpanded = false;
    resultHandle.addEventListener("click", () => {
      resultExpanded = !resultExpanded;
      resultPanel.toggleClass("expanded", resultExpanded);
    });

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
    const container = this.contentEl.querySelector(".toolbar-container");
    const toggleBtn = this.contentEl.querySelector(".toolbar-toggle-btn");
    if (container) {
      container.toggleClass("collapsed", this.toolbarCollapsed);
    }
    if (toggleBtn) {
      toggleBtn.textContent = this.toolbarCollapsed ? "▶" : "◀";
      toggleBtn.setAttr("aria-label", this.toolbarCollapsed ? "Expand toolbar" : "Collapse toolbar");
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
      switch (this.settings.apiProvider) {
        case "mathpix": latex = await this.callMathpix(imageBase64); break;
        case "simpletex": latex = await this.callSimpletex(imageBase64); break;
        case "openai": latex = await this.callOpenAI(imageBase64); break;
        case "custom": latex = await this.callCustomAPI(imageBase64); break;
        case "custom-form": latex = await this.callCustomFormAPI(imageBase64); break;
      }

      latex = this.cleanLatex(latex);
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
      switch (this.settings.apiProvider) {
        case "mathpix": latex = await this.callMathpix(imageBase64); break;
        case "simpletex": latex = await this.callSimpletex(imageBase64); break;
        case "openai": latex = await this.callOpenAI(imageBase64); break;
        case "custom": latex = await this.callCustomAPI(imageBase64); break;
        case "custom-form": latex = await this.callCustomFormAPI(imageBase64); break;
      }
      latex = this.cleanLatex(latex);
      this.resultEl.setText(latex);
      this.statusEl.setText("Image recognition complete!");
      this.resultEl.setAttr("data-latex", latex);

      if (window.innerWidth <= 768) {
        const resultPanel = this.contentEl.querySelector(".result-panel");
        if (resultPanel) resultPanel.classList.add("expanded");
      }
    } catch (error) {
      this.statusEl.setText("Error: " + error.message);
      new Notice("Image recognition failed: " + error.message);
      console.error(error);
    }
  }

  async callMathpix(imageBase64) {
    const response = await requestUrl({
      url: "https://api.mathpix.com/v3/text",
      method: "POST",
      headers: {
        "app_id": "your_app_id",
        "app_key": this.settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        src: "data:image/png;base64," + imageBase64,
        formats: ["text", "latex_styled"],
        data_options: {
          include_latex: true,
          include_mathml: false,
        },
      }),
    });
    if (response.status !== 200) throw new Error("Mathpix API error: " + response.text);
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
    if (response.status !== 200) throw new Error("SimpleTex API error (HTTP " + response.status + "): " + response.text);
    const data = response.json;
    if (!data.status) throw new Error("SimpleTex API returned error: " + JSON.stringify(data));
    return data.res?.latex || "";
  }

  async callOpenAI(imageBase64) {
    const response = await requestUrl({
      url: this.settings.apiEndpoint || "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + this.settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: this.settings.customPrompt },
              { type: "image_url", image_url: { url: "data:image/png;base64," + imageBase64 } },
            ],
          },
        ],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });
    if (response.status !== 200) throw new Error("OpenAI API error: " + response.text);
    const data = response.json;
    return data.choices[0]?.message?.content || "";
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
    if (response.status !== 200) throw new Error("Custom API error: " + response.text);
    const data = response.json;
    return data.latex || data.result || data.text || "";
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
    if (response.status !== 200) throw new Error("Custom Form API error (HTTP " + response.status + "): " + response.text);
    const data = response.json;
    return data[this.settings.customResponseField] || "";
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
    latex = latex.replace(/^\$+/, "").replace(/\$+$/, "");
    return latex;
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
  }

  display() {
    const containerEl = this.containerEl;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Handwriting to LaTeX Settings" });

    new Setting(containerEl)
      .setName("API Provider")
      .setDesc("Choose which service to use for formula recognition")
      .addDropdown((dropdown) => dropdown
        .addOption("simpletex", "SimpleTex (Recommended)")
        .addOption("mathpix", "Mathpix")
        .addOption("openai", "OpenAI GPT-4o Vision")
        .addOption("custom", "Custom API (JSON)")
        .addOption("custom-form", "Custom API (Multipart Form)")
        .setValue(this.plugin.settings.apiProvider)
        .onChange(async (value) => { this.plugin.settings.apiProvider = value; await this.plugin.saveSettings(); this.display(); })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("For SimpleTex: use UAT token. For Mathpix: App Key. For OpenAI: API key.")
      .addText((text) => text.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => { this.plugin.settings.apiKey = value; await this.plugin.saveSettings(); })
      );

    if (this.plugin.settings.apiProvider === "custom" || this.plugin.settings.apiProvider === "openai" || this.plugin.settings.apiProvider === "custom-form") {
      new Setting(containerEl)
        .setName("API Endpoint")
        .setDesc("Custom API endpoint URL (optional for OpenAI)")
        .addText((text) => text.setPlaceholder("https://api.example.com/recognize").setValue(this.plugin.settings.apiEndpoint)
          .onChange(async (value) => { this.plugin.settings.apiEndpoint = value; await this.plugin.saveSettings(); })
        );
    }

    if (this.plugin.settings.apiProvider === "openai" || this.plugin.settings.apiProvider === "custom") {
      new Setting(containerEl)
        .setName("Custom Prompt")
        .setDesc("Prompt sent to AI for recognition")
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

    containerEl.createEl("h3", { text: "API Setup Guide" });
    const guide = containerEl.createEl("div");
    guide.innerHTML = `
      <p><strong>SimpleTex (Recommended):</strong> Register at <a href="https://simpletex.cn/">simpletex.cn</a>, go to User Center, create a <strong>UAT (User Authorization Token)</strong> in "User Authorization Token" menu. Paste the token here.</p>
      <p><strong>Mathpix:</strong> Get keys at <a href="https://mathpix.com/">mathpix.com</a>. Most accurate for math formulas.</p>
      <p><strong>OpenAI:</strong> Requires GPT-4o access. Use your OpenAI API key.</p>
      <p><strong>Custom (JSON):</strong> Any API that accepts base64 image and returns JSON with 'latex' field.</p>
      <p><strong>Custom (Multipart Form):</strong> For APIs that accept multipart/form-data upload (like the example below). Set URL, API key, response field name, header name, and image field name.</p>
    `;
  }
}

module.exports = HandwritingLatexPlugin;