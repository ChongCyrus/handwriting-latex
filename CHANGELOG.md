# Changelog 

## [1.2.0] - 2026-07-01

### 🚀 New Features

- **Custom API Providers**  
  Define your own recognition endpoints directly in settings. Supports JSON, Form-Data (multipart), and Raw body types with full control over request method, headers, body template, response path (dot‑notation or JSONPath), and regex extraction. Custom providers appear in the API dropdown with a 🔧 prefix.

- **Preset Templates**  
  One‑click import of pre‑configured templates for OpenAI (GPT‑4o, o1/o3/o4), Anthropic Claude, Google Gemini, and SimpleTex‑style form‑data APIs to get started quickly.

- **Custom Placeholders**  
  Define reusable variables (e.g. `{{model}}`, `{{temperature}}`) that can be used in URLs, headers, body templates, and form‑field values. Built‑in placeholders include `{{image_base64}}`, `{{image}}`, `{{prompt}}`, `{{apiKey}}`, `{{timestamp}}`, `{{datetime}}`, `{{date}}`, `{{time}}`, and `{{random}}`.

- **Secure JSON Template Resolution**  
  Body templates are now parsed as JSON and placeholders are resolved safely without breaking JSON syntax (quotes, backslashes, and control characters are properly escaped).

- **Dynamic Form‑Data Field Generation**  
  For custom form‑data providers, you can add extra fields directly in the settings UI, and optionally provide a JSON template that auto‑generates form fields.

- **Improved Error Parsing**  
  Unified error extraction logic now falls back to common JSON error fields and supports custom error paths for better diagnostic messages.

### 🐛 Fixes & Improvements

- **History Size Handling**  
  Setting `maxHistorySize` to `0` now correctly disables history storage (previously it could cause unexpected truncation).

- **Custom API Response Field**  
  The legacy JSON custom API now respects the `customResponseField` setting (fallbacks to `latex`, `result`, `text` remain).

- **Provider Management UI**  
  Custom providers can be reordered, duplicated, and deleted directly from the settings pane with an intuitive card‑based interface.

- **Placeholder Support in Legacy Modes**  
  The legacy custom‑form mode now also supports the full range of placeholders in additional form fields.

---

*This release significantly extends the plugin's flexibility, allowing you to connect to virtually any vision‑based LaTeX OCR API.*

---

## [1.1.0] - 2026-06-26

### 🚀 New Features

- **History Navigation**  
  Added recognition result history with backward/forward navigation (←/→). You can set the maximum history size in settings (default: 30). Each successful recognition is automatically saved.

- **Resizable Result Panel**  
  The result panel height can now be adjusted by dragging the handle (mouse or touch). The expanded/collapsed state and custom height are remembered.

- **OpenAI Model & Detail Control**  
  Customizable OpenAI model name (e.g., `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`) and image detail level (`low`, `high`, `auto`, `original`). For reasoning models (o1/o3/o4 series), the `temperature` parameter is automatically disabled for compatibility.

- **Mathpix App ID Configuration**  
  Mathpix API now requires a separate App ID (previously hardcoded). You can fill it in settings, improving security and usability.

- **Smart LaTeX Cleaning**  
  Extraneous delimiters (e.g., `$$...$$`, `$...$`, `\[...\]`, `\(...\)`) are automatically stripped from recognition results, leaving only the core LaTeX code to avoid nesting issues.

- **Adaptive Canvas Width on Desktop**  
  On wide screens, the canvas width automatically expands based on window size (up to the configured maximum) for a more comfortable writing space.

- **Toolbar Elevated in Fullscreen Mode**  
  When entering fullscreen, the side toolbar moves to the top of the `body` to ensure it remains visible and unobstructed; it returns to its original position on exit.

- **Toolbar Height Adaptation (Mobile)**  
  On mobile devices, the toolbar’s max height dynamically adjusts to the canvas or screen height to prevent overflow.

- **Improved Error Message Parsing**  
  Unified API error parsing logic now displays clearer error reasons (including HTTP status codes and server‑returned details) when a request fails.

### 🐛 Fixes & Improvements

- **Fixed Mathpix API Calls**  
  Properly uses `app_id` and `app_key` authentication, with validation that App ID is provided.

- **Improved Result Panel Toggle/Drag Interaction**  
  Clicking the handle toggles expansion/collapse without accidentally triggering during drag; expansion state is linked to dragged height.

- **Clean Cropper State on Close**  
  Fully resets cropper zoom, offset, and selection when the modal is closed, preventing visual artifacts on next open.

- **Toolbar Restoration After Fullscreen Exit**  
  Fixed an issue where the toolbar could be lost or misplaced after exiting fullscreen.

- **Enhanced Touch Gesture Stability on Mobile**  
  Optimised two‑finger pinch and single‑finger drag logic in the cropper to reduce accidental triggers.

### ⚙️ New Settings

- `openaiModel`: OpenAI model name (default: `gpt-4o`)
- `openaiDetail`: Image detail level (default: `high`)
- `mathpixAppId`: Mathpix App ID (required)
- `maxHistorySize`: Maximum history entries (default: 30)

---

*This release focuses on improved usability of recognition results, API compatibility, and overall interaction smoothness.*

---
