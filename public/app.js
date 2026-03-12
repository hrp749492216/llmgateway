// --- Constants ---

const MODELS = {
  openai: [
    'gpt-5.4', 'gpt-5.4-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-4o', 'gpt-4o-mini',
    'o3', 'o3-mini', 'o3-pro', 'o4-mini',
  ],
  claude: [
    'claude-opus-4-6', 'claude-sonnet-4-6',
    'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
  ],
  gemini: [
    'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro', 'gemini-2.5-flash',
    'gemini-2.0-flash',
  ],
  openrouter: [], // free text input — user types any model ID
};

// --- State ---

const state = {
  templates: [],    // { name: string, content: string }
  attachments: [],  // { name: string, type: 'text'|'image', content: string, mimeType?: string }
};

let currentController = null;

// --- DOM Helper ---

const $ = (id) => document.getElementById(id);

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  initProvider();
  initAPIKey();
  initTemplates();
  initAttachments();
  initSendButton();
  initCopyButton();
  initClearResponse();
  initAdvancedOptions();
  initClearSession();
  restoreSession();

  // Set pdf.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
});

// ========================================
// Provider & Model
// ========================================

function initProvider() {
  const providerEl = $('provider');
  providerEl.addEventListener('change', () => {
    updateModels();
    loadAPIKey();
    localStorage.setItem('pref_provider', providerEl.value);
  });

  $('model-select').addEventListener('change', () => {
    localStorage.setItem('pref_model_' + $('provider').value, $('model-select').value);
  });

  $('model-custom').addEventListener('input', () => {
    localStorage.setItem('pref_model_' + $('provider').value, $('model-custom').value);
  });
}

function updateModels() {
  const provider = $('provider').value;
  const modelSelect = $('model-select');
  const modelCustom = $('model-custom');
  const browseBtn = $('openrouter-browse');
  const models = MODELS[provider];

  if (models.length === 0) {
    modelSelect.style.display = 'none';
    modelCustom.style.display = 'block';
    if (browseBtn) browseBtn.style.display = 'inline-block';
    const saved = localStorage.getItem('pref_model_' + provider);
    if (saved) modelCustom.value = saved;
  } else {
    modelSelect.style.display = 'block';
    modelCustom.style.display = 'none';
    if (browseBtn) browseBtn.style.display = 'none';
    modelSelect.innerHTML = models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join('');
    const saved = localStorage.getItem('pref_model_' + provider);
    if (saved && models.includes(saved)) {
      modelSelect.value = saved;
    }
  }
}

function getModel() {
  const provider = $('provider').value;
  return MODELS[provider].length === 0
    ? $('model-custom').value.trim()
    : $('model-select').value;
}

// ========================================
// API Key (sessionStorage — cleared on browser close)
// ========================================

function initAPIKey() {
  const keyInput = $('api-key');
  keyInput.addEventListener('input', () => {
    sessionStorage.setItem('apiKey_' + $('provider').value, keyInput.value);
  });

  $('toggle-key').addEventListener('click', () => {
    const isPassword = keyInput.type === 'password';
    keyInput.type = isPassword ? 'text' : 'password';
    $('eye-icon').textContent = isPassword ? 'Hide' : 'Show';
  });
}

function loadAPIKey() {
  $('api-key').value = sessionStorage.getItem('apiKey_' + $('provider').value) || '';
}

// ========================================
// Prompt Templates
// ========================================

function initTemplates() {
  const input = $('template-input');
  const area = $('template-upload-area');

  input.addEventListener('change', () => {
    handleTemplateFiles(input.files);
    input.value = '';
  });

  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    handleTemplateFiles(e.dataTransfer.files);
  });
}

async function handleTemplateFiles(files) {
  for (const file of files) {
    try {
      const content = await extractText(file);
      state.templates.push({ name: file.name, content });
    } catch (err) {
      alert('Failed to parse ' + file.name + ': ' + err.message);
    }
  }
  saveTemplatesToSession();
  renderTemplateList();
}

function renderTemplateList() {
  const list = $('template-list');
  list.innerHTML = state.templates
    .map(
      (t, i) =>
        `<span class="file-chip">
          <span>${escapeHtml(t.name)}</span>
          <button class="remove-btn" data-idx="${i}">&times;</button>
        </span>`
    )
    .join('');

  list.querySelectorAll('.remove-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.templates.splice(+btn.dataset.idx, 1);
      saveTemplatesToSession();
      renderTemplateList();
    })
  );
}

function saveTemplatesToSession() {
  sessionStorage.setItem('templates', JSON.stringify(state.templates));
}

// ========================================
// Attachments
// ========================================

function initAttachments() {
  const input = $('attachment-input');
  const area = $('attachment-upload-area');

  input.addEventListener('change', () => {
    handleAttachmentFiles(input.files);
    input.value = '';
  });

  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    handleAttachmentFiles(e.dataTransfer.files);
  });
}

async function handleAttachmentFiles(files) {
  for (const file of files) {
    try {
      if (file.type.startsWith('image/')) {
        let dataUrl = await readAsDataURL(file);
        // Resize if original file > 3MB (base64 inflates ~33%, and Vercel has 4MB body limit)
        if (file.size > 3 * 1024 * 1024) {
          dataUrl = await resizeImage(dataUrl);
        }
        state.attachments.push({
          name: file.name,
          type: 'image',
          content: dataUrl,
          mimeType: file.type,
        });
      } else {
        const content = await extractText(file);
        state.attachments.push({ name: file.name, type: 'text', content });
      }
    } catch (err) {
      alert('Failed to read ' + file.name + ': ' + err.message);
    }
  }
  renderAttachmentList();
}

function renderAttachmentList() {
  const list = $('attachment-list');
  list.innerHTML = state.attachments
    .map(
      (a, i) =>
        `<span class="file-chip">
          <span>${a.type === 'image' ? '🖼 ' : '📄 '}${escapeHtml(a.name)}</span>
          <button class="remove-btn" data-idx="${i}">&times;</button>
        </span>`
    )
    .join('');

  list.querySelectorAll('.remove-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.attachments.splice(+btn.dataset.idx, 1);
      renderAttachmentList();
    })
  );
}

// ========================================
// File Parsing (client-side)
// ========================================

async function extractText(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'py'].includes(ext)) {
    return readAsText(file);
  }
  if (ext === 'pdf') {
    return extractPDFText(file);
  }
  if (['docx', 'doc'].includes(ext)) {
    return extractDocxText(file);
  }
  // Fallback: attempt text read
  return readAsText(file);
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Failed to read as text'));
    r.readAsText(file);
  });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Failed to read as data URL'));
    r.readAsDataURL(file);
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Failed to read as array buffer'));
    r.readAsArrayBuffer(file);
  });
}

async function extractPDFText(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF.js not loaded. Please refresh and try again.');
  }
  const buf = await readAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return text.trim();
}

async function extractDocxText(file) {
  if (typeof mammoth === 'undefined') {
    throw new Error('Mammoth.js not loaded. Please refresh and try again.');
  }
  const buf = await readAsArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

function resizeImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX_DIM = 2048;
      let { width, height } = img;

      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl); // fallback: return original
    img.src = dataUrl;
  });
}

// ========================================
// Advanced Options
// ========================================

function initAdvancedOptions() {
  ['temperature', 'top-p', 'max-tokens', 'output-format'].forEach((id) => {
    const el = $(id);
    el.addEventListener('change', saveAdvancedOptions);
    if (el.tagName === 'INPUT') {
      el.addEventListener('input', saveAdvancedOptions);
    }
  });
}

function saveAdvancedOptions() {
  const maxVal = $('max-tokens').value.trim();
  sessionStorage.setItem(
    'advancedOptions',
    JSON.stringify({
      temperature: parseFloat($('temperature').value),
      topP: parseFloat($('top-p').value),
      maxTokens: maxVal ? parseInt(maxVal) : null,
      outputFormat: $('output-format').value,
    })
  );
}

// ========================================
// Session Restore & Clear
// ========================================

function restoreSession() {
  // Provider (from localStorage — persists across sessions)
  const provider = localStorage.getItem('pref_provider');
  if (provider && MODELS[provider] !== undefined) {
    $('provider').value = provider;
  }

  updateModels();
  loadAPIKey();

  // Templates (from sessionStorage)
  try {
    const t = sessionStorage.getItem('templates');
    if (t) {
      state.templates = JSON.parse(t);
      renderTemplateList();
    }
  } catch {}

  // Advanced options (from sessionStorage)
  try {
    const o = sessionStorage.getItem('advancedOptions');
    if (o) {
      const opts = JSON.parse(o);
      if (opts.temperature != null) $('temperature').value = opts.temperature;
      if (opts.topP != null) $('top-p').value = opts.topP;
      $('max-tokens').value = opts.maxTokens != null ? opts.maxTokens : '';
      if (opts.outputFormat) $('output-format').value = opts.outputFormat;
    }
  } catch {}
}

function initClearSession() {
  $('clear-session-btn').addEventListener('click', () => {
    if (!confirm('Clear all session data (API keys, templates, settings)?')) return;
    sessionStorage.clear();
    state.templates = [];
    state.attachments = [];
    renderTemplateList();
    renderAttachmentList();
    $('api-key').value = '';
    $('user-prompt').value = '';
    $('temperature').value = '0.7';
    $('top-p').value = '1.0';
    $('max-tokens').value = '';
    $('output-format').value = 'none';
    $('response-section').style.display = 'none';
  });
}

// ========================================
// Send Request
// ========================================

function initSendButton() {
  $('send-btn').addEventListener('click', handleSendClick);

  // Ctrl+Enter / Cmd+Enter to send
  $('user-prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSendClick();
    }
  });
}

function handleSendClick() {
  if (currentController) {
    // Currently streaming — abort
    currentController.abort();
    currentController = null;
    resetSendButton();
    return;
  }
  sendRequest();
}

function resetSendButton() {
  const btn = $('send-btn');
  btn.textContent = 'Send Request';
  btn.classList.remove('stop');
  btn.disabled = false;
}

async function sendRequest() {
  const provider = $('provider').value;
  const model = getModel();
  const apiKey = $('api-key').value.trim();
  const userPrompt = $('user-prompt').value.trim();

  // Validation
  if (!apiKey) {
    alert('Please enter your API key.');
    $('api-key').focus();
    return;
  }
  if (!model) {
    alert('Please select or enter a model.');
    return;
  }
  if (!userPrompt && state.templates.length === 0 && state.attachments.length === 0) {
    alert('Please enter a prompt or upload files.');
    return;
  }

  const messages = buildMessages(userPrompt);
  const temperature = parseFloat($('temperature').value) || 0.7;
  const topP = parseFloat($('top-p').value) || 1.0;
  const maxTokensVal = $('max-tokens').value.trim();
  const maxTokens = maxTokensVal ? parseInt(maxTokensVal) : null;
  const outputFormat = $('output-format').value;

  // UI: show response area, set loading
  const responseSection = $('response-section');
  responseSection.style.display = 'block';
  const output = $('response-output');
  output.className = 'streaming';
  output.innerHTML = '<span class="loading-indicator">Connecting</span>';
  $('response-meta').textContent = '';

  // UI: switch to Stop button
  const sendBtn = $('send-btn');
  sendBtn.textContent = 'Stop';
  sendBtn.classList.add('stop');

  currentController = new AbortController();
  const startTime = Date.now();
  let fullText = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        apiKey,
        messages,
        temperature,
        topP,
        ...(maxTokens ? { maxTokens } : {}),
        outputFormat,
      }),
      signal: currentController.signal,
    });

    if (!res.ok) {
      let errMsg;
      try {
        const errBody = await res.json();
        errMsg = errBody.error || res.statusText;
      } catch {
        errMsg = res.statusText;
      }
      output.className = '';
      output.textContent = 'Error: ' + errMsg;
      return;
    }

    // Stream the response
    output.textContent = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') break;

        try {
          const parsed = JSON.parse(data);
          if (parsed.content) {
            fullText += parsed.content;
            output.textContent = fullText;
            // Only auto-scroll if user is near the bottom (within 50px)
            const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
            if (nearBottom) output.scrollTop = output.scrollHeight;
          }
          if (parsed.error) {
            fullText += '\n[Error: ' + parsed.error + ']';
            output.textContent = fullText;
          }
        } catch {
          // skip malformed chunk
        }
      }
    }

    // Render final output with markdown (if available)
    renderFinalOutput(fullText, outputFormat);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    $('response-meta').textContent =
      model + ' | ' + elapsed + 's | ' + fullText.length + ' chars';
  } catch (err) {
    if (err.name === 'AbortError') {
      $('response-meta').textContent = 'Request cancelled';
      if (!fullText) {
        output.className = '';
        output.textContent = '(cancelled)';
      } else {
        renderFinalOutput(fullText, outputFormat);
      }
    } else {
      output.className = '';
      output.textContent = 'Network error: ' + err.message;
    }
  } finally {
    currentController = null;
    resetSendButton();
  }
}

function renderFinalOutput(text, outputFormat) {
  const output = $('response-output');

  if (outputFormat === 'json') {
    // Try to pretty-print JSON
    try {
      const parsed = JSON.parse(text);
      output.className = 'rendered';
      output.innerHTML =
        '<pre><code>' + escapeHtml(JSON.stringify(parsed, null, 2)) + '</code></pre>';
    } catch {
      output.className = '';
      output.textContent = text;
    }
    return;
  }

  if (outputFormat === 'text') {
    output.className = '';
    output.style.whiteSpace = 'pre-wrap';
    output.textContent = text;
    return;
  }

  // Default: render as markdown if marked.js is available
  if (typeof marked !== 'undefined') {
    try {
      marked.setOptions({ breaks: true, gfm: true });
      output.className = 'rendered';
      output.innerHTML = marked.parse(text);
    } catch {
      output.className = '';
      output.textContent = text;
    }
  } else {
    output.className = '';
    output.textContent = text;
  }
}

function buildMessages(userPrompt) {
  const messages = [];

  // System message from templates
  if (state.templates.length > 0) {
    const templateText = state.templates
      .map((t) => '--- Template: ' + t.name + ' ---\n' + t.content)
      .join('\n\n');
    messages.push({ role: 'system', content: templateText });
  }

  // User message: text attachments + prompt + images
  const userParts = [];

  // Text-based attachments as context
  const textAttachments = state.attachments.filter((a) => a.type === 'text');
  if (textAttachments.length > 0) {
    const ctx = textAttachments
      .map((a) => '--- Attached: ' + a.name + ' ---\n' + a.content)
      .join('\n\n');
    userParts.push({ type: 'text', text: ctx });
  }

  // User prompt
  if (userPrompt) {
    userParts.push({ type: 'text', text: userPrompt });
  }

  // Image attachments
  const imageAttachments = state.attachments.filter((a) => a.type === 'image');
  for (const img of imageAttachments) {
    userParts.push({
      type: 'image_url',
      image_url: { url: img.content },
    });
  }

  if (userParts.length > 0) {
    // Simplify to string if only one text part and no images
    if (userParts.length === 1 && userParts[0].type === 'text') {
      messages.push({ role: 'user', content: userParts[0].text });
    } else {
      messages.push({ role: 'user', content: userParts });
    }
  }

  return messages;
}

// ========================================
// Copy & Clear Response
// ========================================

function initCopyButton() {
  $('copy-btn').addEventListener('click', () => {
    const output = $('response-output');
    const text = output.textContent || output.innerText;
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    });
  });
}

function initClearResponse() {
  $('clear-response-btn').addEventListener('click', () => {
    $('response-section').style.display = 'none';
    $('response-output').textContent = '';
    $('response-meta').textContent = '';
  });
}

// ========================================
// Utilities
// ========================================

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
