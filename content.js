// ─── State ───────────────────────────────────────────────────────────────────
let explainBtn = null;
let explanationPanel = null;
let selectedText = '';
let selectionRect = null;
let language = 'zh';         // default; overridden by stored preference
let conversationHistory = [];
let isPending = false;
let lastMouseDown = null;       // track drag gestures for Google Docs fallback
let lastDoubleClick = 0;
let lastExplainTrigger = 0;    // prevents mouseup after button click from killing the panel

// Load stored language preference
chrome.storage.sync.get({ defaultLang: 'zh' }, ({ defaultLang }) => {
  language = defaultLang;
});

// ─── Event Listeners ─────────────────────────────────────────────────────────
// Use capture:true so we receive events even when Google Docs calls stopPropagation()
document.addEventListener('mouseup', (e) => handleSelectionChange(e), true);
document.addEventListener('pointerup', (e) => handleSelectionChange(e), true);
document.addEventListener('keyup', (e) => { if (e.shiftKey) handleSelectionChange(e); }, true);
document.addEventListener('mousedown', (e) => {
  lastMouseDown = { x: e.clientX, y: e.clientY };
  if (!explanationPanel?.contains(e.target) && !explainBtn?.contains(e.target)) {
    hideAll();
  }
}, true);
document.addEventListener('dblclick', () => { lastDoubleClick = Date.now(); }, true);

// ─── Google Docs Helpers ─────────────────────────────────────────────────────
function isGoogleDocs() {
  return location.hostname === 'docs.google.com';
}

// Did the user perform a gesture that likely means text selection?
// (drag or double-click — avoids false positives from simple clicks)
function wasSelectionGesture(e) {
  if (!e) return false;
  if (Date.now() - lastDoubleClick < 500) return true;
  if (!lastMouseDown) return false;
  return Math.abs(e.clientX - lastMouseDown.x) > 5
      || Math.abs(e.clientY - lastMouseDown.y) > 5;
}

// Read clipboard text via execCommand('paste') into an off-screen textarea.
// Requires the "clipboardRead" permission in manifest.json.
function readClipboardText() {
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus();
  document.execCommand('paste');
  const text = ta.value;
  ta.remove();
  try { if (prev) prev.focus(); } catch { /* ignore */ }
  return text;
}

// Attempt to read Google Docs' internal selection via the clipboard.
// Must be called synchronously during a user-gesture (mouseup) — NOT inside
// a setTimeout, which forfeits the gesture context and makes execCommand
// silently fail.  Returns the selected text, or '' if it can't be captured.
function captureGoogleDocsSelection() {
  try {
    // 1. Snapshot what's already on the clipboard
    const before = readClipboardText() || '';

    // 2. readClipboardText() restored focus to Google Docs' editor.
    //    Now execCommand('copy') fires a trusted copy event on that element.
    //    Google Docs intercepts it and writes its canvas selection to the
    //    system clipboard.
    document.execCommand('copy');

    // 3. Read the clipboard again
    const after = readClipboardText() || '';

    // 4. Only trust the result if the clipboard actually changed — this
    //    prevents stale clipboard content from being used as "selected text".
    if (after && after.trim() !== before.trim()) {
      return after.trim();
    }
  } catch { /* clipboard not available */ }
  return '';
}

// ─── Selection ───────────────────────────────────────────────────────────────
function handleSelectionChange(e) {
  // The mouseup/pointerup from clicking the explain button would otherwise
  // run this handler, find no selection, and call hideAll() — killing the
  // panel that was just opened.  Ignore events that arrive within 500 ms
  // of the last explain trigger.
  if (Date.now() - lastExplainTrigger < 500) return;

  const onGoogleDocs = isGoogleDocs();

  // For Google Docs canvas mode: capture clipboard text NOW, while the
  // user-gesture is still active.  document.execCommand('copy') requires
  // user-activation which a setTimeout would forfeit.
  let gdocsText = '';
  if (onGoogleDocs && wasSelectionGesture(e)) {
    gdocsText = captureGoogleDocsSelection();
  }

  const delay = onGoogleDocs ? 200 : 60;

  setTimeout(() => {
    const selection = window.getSelection();
    let text = selection?.toString().trim();

    // Google Docs canvas mode: window.getSelection() returns empty because
    // text is rendered on <canvas>, not in DOM nodes.  Use the clipboard
    // text we captured earlier (if the copy succeeded).
    if ((!text || text.length < 2) && gdocsText.length >= 2) {
      text = gdocsText;
    }

    if (!text || text.length < 2) { hideAll(); return; }

    selectedText = text;

    // Try to use the real selection rect; fall back to mouse cursor position
    // (Google Docs returns zero-sized rects for its hidden selection layer)
    let rect = null;
    try {
      if (selection.rangeCount > 0) {
        const r = selection.getRangeAt(0).getBoundingClientRect();
        if (r.width > 0 || r.height > 0) rect = r;
      }
    } catch { /* ignore */ }

    if (!rect && e) {
      // Synthesise a rect from the mouse-up position
      rect = { top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX };
    }

    if (!rect) return;
    selectionRect = rect;
    showExplainButton(selectionRect);
  }, delay);
}

function showExplainButton(rect) {
  removeElement(explainBtn);
  explainBtn = document.createElement('div');
  explainBtn.className = 're-explain-btn';
  explainBtn.textContent = '✦ Explain';
  explainBtn.style.top = `${rect.bottom + window.scrollY + 8}px`;
  explainBtn.style.left = `${rect.left + window.scrollX}px`;
  explainBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    triggerExplanation();
  });
  document.body.appendChild(explainBtn);
}

// ─── Explanation Flow ─────────────────────────────────────────────────────────
function triggerExplanation() {
  lastExplainTrigger = Date.now();
  removeElement(explainBtn);
  explainBtn = null;
  conversationHistory = [];
  isPending = false;

  showPanel();

  const context = getSurroundingContext(selectedText);
  const firstMsg = context
    ? `Context: "${context}"\n\nExplain this: "${selectedText}"`
    : `Explain this: "${selectedText}"`;

  conversationHistory.push({ role: 'user', content: firstMsg });
  addLoadingMessage();
  callAPI();
}

function callAPI() {
  // After the extension is reloaded, old content scripts lose their
  // connection to the runtime.  Detect this and show a friendly message
  // instead of throwing "Extension context invalidated".
  if (!chrome.runtime?.id) {
    resolveLoadingMessage(
      language === 'zh'
        ? '扩展已更新，请刷新此页面后重试。'
        : 'Extension was reloaded — please refresh this page.',
      true
    );
    conversationHistory.pop();
    return;
  }

  isPending = true;
  setSendDisabled(true);

  chrome.runtime.sendMessage(
    { type: 'EXPLAIN', messages: conversationHistory, language },
    (response) => {
      isPending = false;
      setSendDisabled(false);

      if (chrome.runtime.lastError) {
        resolveLoadingMessage(chrome.runtime.lastError.message, true);
        conversationHistory.pop();
        return;
      }
      if (response.success) {
        resolveLoadingMessage(response.reply, false);
        conversationHistory.push({ role: 'assistant', content: response.reply });
      } else {
        resolveLoadingMessage(response.error, true);
        conversationHistory.pop();
      }
    }
  );
}

function sendFollowup() {
  if (isPending || !explanationPanel) return;
  const input = explanationPanel.querySelector('.re-followup-input');
  const text = input?.value.trim();
  if (!text) return;

  input.value = '';
  conversationHistory.push({ role: 'user', content: text });
  appendUserBubble(text);
  addLoadingMessage();
  callAPI();
}

// ─── Panel Construction ───────────────────────────────────────────────────────
function showPanel() {
  removeElement(explanationPanel);

  const top = selectionRect.bottom + window.scrollY + 8;
  let left = selectionRect.left + window.scrollX;
  if (left + 410 > window.innerWidth - 10) left = Math.max(10, window.innerWidth - 420);

  explanationPanel = document.createElement('div');
  explanationPanel.className = 're-panel';
  explanationPanel.style.top = `${top}px`;
  explanationPanel.style.left = `${left}px`;

  explanationPanel.innerHTML = `
    <div class="re-header">
      <span class="re-icon">✦</span>
      <span class="re-term">${escapeHtml(truncate(selectedText, 35))}</span>
      <div class="re-lang-toggle">
        <button class="re-lang ${language === 'zh' ? 'active' : ''}" data-lang="zh">中文</button>
        <button class="re-lang ${language === 'en' ? 'active' : ''}" data-lang="en">EN</button>
      </div>
      <button class="re-close" title="Close">×</button>
    </div>
    <div class="re-conversation"></div>
    <div class="re-input-area">
      <input class="re-followup-input" type="text"
        placeholder="${language === 'zh' ? '继续追问…' : 'Ask a follow-up…'}"
        autocomplete="off" />
      <button class="re-send-btn" title="Send">↑</button>
    </div>
  `;

  document.body.appendChild(explanationPanel);

  // Close button
  explanationPanel.querySelector('.re-close').addEventListener('click', hideAll);

  // Language toggle
  explanationPanel.querySelectorAll('.re-lang').forEach(btn => {
    btn.addEventListener('click', () => {
      language = btn.dataset.lang;
      explanationPanel.querySelectorAll('.re-lang').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const input = explanationPanel.querySelector('.re-followup-input');
      if (input) input.placeholder = language === 'zh' ? '继续追问…' : 'Ask a follow-up…';
    });
  });

  // Follow-up input
  const input = explanationPanel.querySelector('.re-followup-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
  });
  explanationPanel.querySelector('.re-send-btn').addEventListener('click', sendFollowup);
}

// ─── Conversation Messages ────────────────────────────────────────────────────
function getConv() {
  return explanationPanel?.querySelector('.re-conversation');
}

function addLoadingMessage() {
  const conv = getConv();
  if (!conv) return;
  const el = document.createElement('div');
  el.className = 're-msg re-msg-ai re-msg-loading';
  el.innerHTML = `<span class="re-spinner"></span><span>${language === 'zh' ? '思考中…' : 'Thinking…'}</span>`;
  conv.appendChild(el);
  conv.scrollTop = conv.scrollHeight;
}

function resolveLoadingMessage(text, isError) {
  const conv = getConv();
  if (!conv) return;
  const loading = conv.querySelector('.re-msg-loading');
  if (!loading) return;

  if (isError) {
    loading.className = 're-msg re-msg-error';
    loading.textContent = '⚠ ' + text;
  } else {
    loading.className = 're-msg re-msg-ai';
    loading.innerHTML = renderMarkdown(text);
  }
  conv.scrollTop = conv.scrollHeight;
}

function appendUserBubble(text) {
  const conv = getConv();
  if (!conv) return;
  const el = document.createElement('div');
  el.className = 're-msg re-msg-user';
  el.textContent = text;
  conv.appendChild(el);
  conv.scrollTop = conv.scrollHeight;
}

function setSendDisabled(disabled) {
  const btn = explanationPanel?.querySelector('.re-send-btn');
  if (btn) btn.disabled = disabled;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getSurroundingContext(text) {
  try {
    const full = document.body.innerText;
    const idx = full.indexOf(text);
    if (idx === -1) return '';
    const s = Math.max(0, idx - 300);
    const e = Math.min(full.length, idx + text.length + 300);
    return full.slice(s, e).replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return `<p>${escaped}</p>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function hideAll() {
  removeElement(explainBtn);
  removeElement(explanationPanel);
  explainBtn = null;
  explanationPanel = null;
}

function removeElement(el) {
  if (el?.parentNode) el.parentNode.removeChild(el);
}
