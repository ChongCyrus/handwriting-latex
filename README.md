# Handwriting to LaTeX for Obsidian

![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Plugin-purple)
![Version](https://img.shields.io/github/v/release/yourusername/obsidian-handwriting-latex)
![Downloads](https://img.shields.io/github/downloads/yourusername/obsidian-handwriting-latex/total)

**Handwriting to LaTeX** is an Obsidian plugin that lets you draw mathematical formulas directly on a canvas, or import images from your gallery, and convert them into LaTeX code using optical character recognition (OCR). It supports multiple API backends, with **SimpleTex** as the recommended (and free) option.

---

## ✨ Features

- ✍️ **Handwriting canvas** – draw with your finger or mouse, with pen/eraser/pan modes.
- 📷 **Image import** – load images from your device’s photo gallery.
- 🧠 **Formula recognition** – powered by:
  - [SimpleTex](https://simpletex.cn/) (recommended, free UAT token)
  - Custom APIs (JSON or multipart/form-data)
  - *(Experimental)* Mathpix, OpenAI GPT-4o Vision
- 🎯 **Smart crop** – select exactly the region you want to recognize.
- 🌀 **Infinite canvas** – auto‑expands, zoom & pan, rotate, undo, clear.
- 📐 **Math mode** – insert as inline (`$...$`), display (`$$...$$`), or raw LaTeX.
- 📱 **Mobile friendly** – fully optimized for touch devices.
- 🎨 **Customizable** – stroke color/width, grid, default canvas size.

---

## 📦 Installation

### From Obsidian Community Plugins (once published)
1. Open **Settings** → **Community Plugins**.
2. Disable **Safe Mode**.
3. Click **Browse** and search for “Handwriting to LaTeX”.
4. Install and enable the plugin.

### Manual (BRAT)
1. Install the [BRAT](https://github.com/TfTHacker/obsidian-brat) plugin.
2. Add this repository: `yourusername/obsidian-handwriting-latex`.
3. Enable the plugin.

---

## 🚀 Usage

### Open the handwriting modal
- Click the **pencil icon** in the ribbon (left sidebar).
- Or run the command: **“Open handwriting canvas”** from the Command Palette (`Cmd/Ctrl+P`).

### Drawing on the canvas
- **Pen mode** (✏️) – draw freely.
- **Eraser mode** (🧹) – tap/click strokes to remove them.
- **Hand mode** (✋) – pan around the canvas.
- **Zoom** – pinch on touch, or use mouse wheel.
- **Undo** (↩️) – remove the last stroke.
- **Clear** (🗑️) – erase everything.
- **Rotate** (↺/↻) – rotate all strokes by 90°.
- **Fit view** (⊘) – zoom to fit all content.
- **Reset view** (🏠) – return to default zoom/pan.
- **Grid toggle** (⊞) – show/hide background grid.

### Recognizing a formula
1. Draw your formula (or import an image via the 📷 or 🖼️ buttons).
2. Click the **“🔍 Recognize”** button (top‑right or inside the crop window).
3. The LaTeX result will appear in the right‑hand panel (or slide‑up on mobile).
4. Choose your **insert mode** (inline/display/raw).
5. Click **“✅ Insert”** – the LaTeX is inserted at your cursor position.

### Importing images
- **Camera** (📷) – opens your device camera (only works if Obsidian has camera permissions; on desktop this may not be available).
- **Album** (🖼️) – opens your file picker to select an image.
- After importing, you can **crop** the image to the formula area before recognition.

---

## ⚙️ Configuration

Go to **Settings** → **Handwriting to LaTeX** to configure:

| Setting | Description |
|---------|-------------|
| **API Provider** | Choose SimpleTex, Mathpix, OpenAI, or Custom API. |
| **API Key** | Your API token/key. For SimpleTex, use your **UAT** (User Authorization Token). |
| **API Endpoint** | Required for Custom APIs (and optional for OpenAI). |
| **Custom Prompt** | Prompt sent to OpenAI or Custom JSON APIs. |
| **Response Field** | For Custom Form API: JSON field that contains the LaTeX result. |
| **API Key Header** | For Custom Form API: HTTP header name for your API key. |
| **Image Field Name** | For Custom Form API: form‑data field name for the image. |
| **Math Insert Mode** | Default insert style: inline, display, or raw. |
| **Show Grid** | Toggle background grid on the canvas. |
| **Stroke Color** | Pen color. |
| **Stroke Width** | Pen thickness. |
| **Canvas Width/Height** | Default canvas size in pixels. |

---

## 🔐 API Setup Guides

### SimpleTex (Recommended)
1. Register at [SimpleTex](https://simpletex.cn/).
2. Go to **User Center** → **User Authorization Token**.
3. Create a token (UAT) and copy it.
4. Paste it into the **API Key** field.

### Custom API (JSON)
- Your endpoint should accept a `POST` request with JSON body:
  ```json
  {
    "image": "data:image/png;base64,...",
    "prompt": "your prompt"
  }