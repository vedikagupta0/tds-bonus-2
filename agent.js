/* LLM Agent POC — Browser Multi-Tool with OpenAI-style tool calling
   - Providers: OpenAI, AI Pipe (OpenRouter-style), Google Gemini, Anthropic
   - Tools: web_search (Google CSE or DDG+Wiki fallback), aipipe_proxy, js_exec
   - UI: dark page, light colorful chat card, avatars, spinner, hidden tool/system rows
*/

"use strict";

// -------- DOM helpers --------
const $ = (sel) => document.querySelector(sel);
const chatEl     = $('#chat');
const alertsEl   = $('#alerts');
const codeCard   = $('#codeCard');
const codeOutput = $('#codeOutput');
const statusEl   = $('#status');
const sendBtn    = $('#send');
const clearBtn   = $('#clear');
const exportBtn  = $('#export');

const state = { messages: [], running: false };

// -------- UI helpers --------
function addAlert(type, msg) {
  const el = document.createElement('div');
  el.className = `alert alert-${type} alert-dismissible fade show`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `${msg}<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>`;
  alertsEl.appendChild(el);
}

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function setBusy(b) {
  state.running = !!b;
  if (b) statusEl.classList.remove('d-none'); else statusEl.classList.add('d-none');
  sendBtn.disabled = !!b; clearBtn.disabled = !!b; exportBtn.disabled = !!b;
}

// Colorful chat bubbles with avatars (system/tool hidden)
function addMessage(role, content) {
  if (role === 'tool' || role === 'system') return;

  const row = document.createElement('div');
  row.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.innerHTML = (role === 'user') ? '<i class="bi bi-person-fill"></i>' : '<i class="bi bi-robot"></i>';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = (typeof content === 'string')
    ? content
    : `<pre>${escapeHtml(JSON.stringify(content, null, 2))}</pre>`;

  if (role === 'user') { // right side
    row.appendChild(bubble);
    row.appendChild(avatar);
  } else {               // assistant: left
    row.appendChild(avatar);
    row.appendChild(bubble);
  }

  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// -------- Settings --------
function getSettings() {
  return {
    provider:  $('#provider').value,
    apiKey:    $('#apiKey').value.trim(),
    model:     $('#model').value,
    maxTokens: parseInt($('#maxTokens').value || '800', 10),
    googleKey: $('#googleKey').value.trim(),
    googleCx:  $('#googleCx').value.trim()
  };
}

function validateApiKeyOrWarn(provider, key) {
  const trimmed = (key || '').trim();
  if (!trimmed) {
    if (provider === 'aipipe') return true; // we'll try getProfile() dynamically
    addAlert('warning', 'Missing API key/token for ' + provider + '.');
    return false;
  }
  if (provider === 'openai' && !/^sk-[A-Za-z0-9]/.test(trimmed)) {
    addAlert('warning', 'That does not look like an OpenAI key (should start with "sk-").');
    return false;
  }
  if (provider === 'aipipe' && trimmed.length < 20) {
    addAlert('warning', 'AI Pipe token looks too short.');
    return false;
  }
  return true;
}

// -------- Tool schema (OpenAI-style) --------
const tools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for top snippets (Google CSE if keys provided; otherwise DDG/Wikipedia fallback).",
      parameters: {
        type: "object",
        properties: {
          q:   { type: "string",  description: "Search query" },
          num: { type: "integer", description: "Number of results", default: 3, minimum: 1, maximum: 10 }
        },
        required: ["q"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "aipipe_proxy",
      description: "Call AI Pipe OpenRouter-compatible chat endpoint to get a short completion.",
      parameters: {
        type: "object",
        properties: {
          prompt:     { type: "string" },
          model:      { type: "string", description: "Model on AI Pipe", default: "openai/gpt-4o-mini" },
          max_tokens: { type: "integer", default: 200 }
        },
        required: ["prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "js_exec",
      description: "Securely execute JavaScript code in a sandboxed Worker; return logs & result.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "JavaScript code to run" } },
        required: ["code"]
      }
    }
  }
];

// -------- Model dropdown options --------
const MODEL_OPTIONS = {
  openai: [
    { value: "gpt-4o-mini",  label: "gpt-4o-mini (default)" },
    { value: "gpt-4o",       label: "gpt-4o" },
    { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
    { value: "gpt-4.1",      label: "gpt-4.1" }
  ],
  aipipe: [
    { value: "openai/gpt-4o-mini",               label: "openai/gpt-4o-mini (default)" },
    { value: "openai/gpt-4o",                    label: "openai/gpt-4o" },
    { value: "google/gemini-2.0-flash-lite-001", label: "google/gemini-2.0-flash-lite-001" }
  ],
  anthropic: [
    { value: "claude-3-5-sonnet-latest", label: "claude-3-5-sonnet-latest (default)" },
    { value: "claude-3-opus-latest",     label: "claude-3-opus-latest" },
    { value: "claude-3-haiku-latest",    label: "claude-3-haiku-latest" }
  ],
  gemini: [
    { value: "gemini-2.5-flash", label: "gemini-2.5-flash (default)" },
    { value: "gemini-2.0-flash", label: "gemini-2.0-flash" },
    { value: "gemini-1.5-pro",   label: "gemini-1.5-pro" }
  ]
};

function populateModelOptions() {
  const provider = $('#provider').value || 'openai';
  const sel = $('#model');
  sel.innerHTML = '';
  const opts = MODEL_OPTIONS[provider] || MODEL_OPTIONS.openai;
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label; sel.appendChild(opt);
  }
}

/* -------------------------------
   SANITIZER: Remove empty tool_calls etc.
   ------------------------------- */
function sanitizeMessagesForOpenAI(messages) {
  return messages.map((m) => {
    const out = { role: m.role };

    // Common content handling
    const asString = (v) => (typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v)));

    if (m.role === 'assistant') {
      const tc = Array.isArray(m.tool_calls) ? m.tool_calls.filter(Boolean) : [];
      if (tc.length > 0) {
        // Keep tool_calls, ensure proper shape, set content to null if empty
        out.tool_calls = tc.map((t) => ({
          id: t.id,
          type: 'function',
          function: {
            name: t.function?.name,
            arguments: typeof t.function?.arguments === 'string'
              ? t.function.arguments
              : JSON.stringify(t.function?.arguments || {})
          }
        }));
        const c = (m.content ?? '').toString().trim();
        out.content = c.length ? c : null; // OpenAI allows null when using tool_calls
      } else {
        // DO NOT send empty array
        out.content = asString(m.content ?? '');
      }
    } else if (m.role === 'tool') {
      out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      out.content = asString(m.content ?? '');
    } else {
      // user/system
      out.content = asString(m.content ?? '');
      if (m.name) out.name = m.name;
    }
    return out;
  });
}

// -------- Core reasoning loop (assistant always pushed; tool ids matched) --------
async function agentLoop() {
  if (state.running) return;
  setBusy(true);

  try {
    let turns = 0;
    while (turns++ < 8) {
      const resp = await callLLM(state.messages, tools);
      if (!resp) break;

      const msg = getAssistantMessage(resp);

      // Only include tool_calls when non-empty
      const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls.filter(Boolean) : [];
      const assistantMsg = {
        role: 'assistant',
        content: msg?.content || ''
      };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      state.messages.push(assistantMsg);

      // Render assistant text if any
      if (msg?.content) addMessage('assistant', escapeHtml(msg.content));

      // Execute tool calls
      if (toolCalls.length === 0) break;

      for (const tc of toolCalls) {
        let args = {};
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments || {});
        } catch {}

        const result = await executeTool(tc.function.name, args).catch(e => ({ error: String(e) }));

        // Push tool result with matching tool_call_id
        state.messages.push({
          role: 'tool',
          tool_call_id: tc.id || undefined,
          name: tc.function.name,
          content: JSON.stringify(result)
        });
      }
      // Loop so the LLM can consume tool results
    }
  } catch (err) {
    addAlert('danger', 'Agent loop error: ' + escapeHtml(err?.message || String(err)));
  } finally {
    setBusy(false);
  }
}

// -------- LLM call dispatcher --------
async function callLLM(messages, tools) {
  const { provider, apiKey, model, maxTokens } = getSettings();

  // Try to auto-fetch AI Pipe token if missing
  let key = apiKey;
  if (provider === 'aipipe' && !key) {
    try {
      const mod = await import('https://aipipe.org/aipipe.js');
      const profile = mod?.getProfile?.();
      if (profile?.token) key = profile.token;
      else {
        window.location = `https://aipipe.org/login?redirect=${encodeURIComponent(window.location.href)}`;
        return null;
      }
    } catch {
      addAlert('warning', 'Could not load AI Pipe profile. Enter your AI Pipe token manually.');
      return null;
    }
  }

  if (!validateApiKeyOrWarn(provider, key)) return null;

  try {
    if (provider === 'openai')    return await callOpenAI(key, model, messages, maxTokens, tools);
    if (provider === 'aipipe')    return await callAIPipe(key, model, messages, maxTokens, tools);
    if (provider === 'gemini')    return await callGemini(key, model, messages, maxTokens, tools);
    if (provider === 'anthropic') return await callAnthropic(key, model, messages, maxTokens, tools);
    addAlert('danger', 'Unsupported provider: ' + provider);
    return null;
  } catch (err) {
    addAlert('danger', `${provider} error: ` + escapeHtml(err?.message || String(err)));
    return null;
  }
}

// -------- Provider: OpenAI --------
async function callOpenAI(apiKey, model, messages, maxTokens, tools) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  const safeMessages = sanitizeMessagesForOpenAI(messages);
  const body = { model, messages: safeMessages, max_tokens: maxTokens, temperature: 0.7, tools };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

// -------- Provider: AI Pipe (OpenRouter-compatible) --------
async function callAIPipe(apiKey, model, messages, maxTokens, tools) {
  const url = 'https://aipipe.org/openrouter/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` };
  const safeMessages = sanitizeMessagesForOpenAI(messages);
  const body = { model, messages: safeMessages, max_tokens: maxTokens, temperature: 0.7, tools };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return await res.json();
}

// -------- Provider: Google Gemini (v1beta) --------
function toGeminiTools(openaiTools) {
  const fns = (openaiTools || []).map(t => t?.function).filter(Boolean).map(fn => ({
    name: fn.name, description: fn.description || '', parameters: fn.parameters || { type: 'object' }
  }));
  return fns.length ? [{ functionDeclarations: fns }] : [];
}
function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] });
    } else if (m.role === 'tool') {
      let parsed = null; try { parsed = JSON.parse(m.content); } catch { parsed = { text: String(m.content) }; }
      contents.push({ role: 'tool', parts: [{ functionResponse: { name: m.name || 'tool', response: parsed } }] });
    }
  }
  return contents;
}
function fromGeminiResponseToOpenAI(data) {
  const choices = [{ message: { role: 'assistant', content: '', tool_calls: [] } }];
  const msg = choices[0].message;
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (typeof p?.text === 'string') msg.content += (msg.content ? '\n' : '') + p.text;
    if (p?.functionCall && p.functionCall.name) {
      msg.tool_calls.push({
        id: 'gemini_' + Math.random().toString(36).slice(2),
        type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) }
      });
    }
  }
  return { choices };
}
async function callGemini(apiKey, model, messages, maxTokens, openaiTools) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const headers = { 'Content-Type': 'application/json' };
  const body = {
    contents: toGeminiContents(messages),
    tools: toGeminiTools(openaiTools),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ` + (await res.text()));
  const data = await res.json();
  return fromGeminiResponseToOpenAI(data);
}

// -------- Provider: Anthropic Claude --------
function toAnthropicTools(openaiTools) {
  return (openaiTools || []).map(t => t?.function).filter(Boolean).map(fn => ({
    name: fn.name, description: fn.description || '', input_schema: fn.parameters || { type: 'object' }
  }));
}
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content: [{ type: 'text', text: String(m.content || '') }] });
    } else if (m.role === 'tool') {
      let parsed = null; try { parsed = JSON.parse(m.content); } catch { parsed = { text: String(m.content) }; }
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: (m.tool_call_id || 'tool_' + Math.random().toString(36).slice(2)), content: JSON.stringify(parsed), is_error: false }] });
    }
  }
  return out;
}
function fromAnthropicResponseToOpenAI(data) {
  const choices = [{ message: { role: 'assistant', content: '', tool_calls: [] } }];
  const msg = choices[0].message;
  const blocks = data?.content || [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') msg.content += (msg.content ? '\n' : '') + b.text;
    else if (b.type === 'tool_use') {
      msg.tool_calls.push({ id: b.id || ('claude_' + Math.random().toString(36).slice(2)), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
    }
  }
  return { choices };
}
async function callAnthropic(apiKey, model, messages, maxTokens, openaiTools) {
  const url = 'https://api.anthropic.com/v1/messages';
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const body = { model, max_tokens: maxTokens, temperature: 0.7, tools: toAnthropicTools(openaiTools), messages: toAnthropicMessages(messages) };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ` + (await res.text()));
  const data = await res.json();
  return fromAnthropicResponseToOpenAI(data);
}

// -------- Extract assistant message --------
function getAssistantMessage(data) { return (data?.choices?.length ? data.choices[0].message : null); }

// -------- Tools --------
async function executeTool(name, args) {
  switch (name) {
    case 'web_search':   return await toolWebSearch(args);
    case 'aipipe_proxy': return await toolAIPipeProxy(args);
    case 'js_exec':      return await toolJsExec(args);
    default:             return { error: 'Unknown tool: ' + name };
  }
}

// Web search: Google CSE (if keys) OR DuckDuckGo + Wikipedia fallback (no keys)
async function toolWebSearch({ q, num = 3 }) {
  const { googleKey, googleCx } = getSettings();

  if (googleKey && googleCx) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(q)}&num=${num}`;
    const res = await fetch(url);
    if (!res.ok) return { error: `Google CSE error: ${res.status} ${res.statusText}`, detail: await res.text() };
    const json = await res.json();
    const items = (json.items || []).map(i => ({ title: i.title, link: i.link, snippet: i.snippet }));
    return { query: q, provider: "google_cse", items };
  }

  // DuckDuckGo
  let ddg = null;
  try {
    const ddgRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
    if (ddgRes.ok) {
      const data = await ddgRes.json();
      const items = [];
      if (data.AbstractText) {
        items.push({ title: data.Heading || q, link: data.AbstractURL || (data.Results?.[0]?.FirstURL) || "", snippet: data.AbstractText });
      }
      if (Array.isArray(data.RelatedTopics)) {
        for (const rt of data.RelatedTopics.slice(0, Math.max(0, num - items.length))) {
          if (rt?.Text) items.push({ title: (rt?.Text.split(" - ")[0]) || q, link: rt?.FirstURL || "", snippet: rt?.Text });
        }
      }
      if (items.length) ddg = { query: q, provider: "duckduckgo", items };
    }
  } catch {}

  // Wikipedia
  let wiki = null;
  try {
    const titleGuess = q.trim().replace(/\s+/g, "_");
    const wres = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titleGuess)}`);
    if (wres.ok) {
      const w = await wres.json();
      if (w?.extract) {
        wiki = { query: q, provider: "wikipedia", items: [{ title: w.title || q, link: w.content_urls?.desktop?.page || w.content_urls?.mobile?.page || "", snippet: w.extract }] };
      }
    }
  } catch {}

  if (ddg && wiki) return { query: q, provider: "fallback(duckduckgo+wiki)", items: [...ddg.items.slice(0, Math.max(0, num - 1)), ...wiki.items.slice(0, 1)] };
  if (ddg)  return ddg;
  if (wiki) return wiki;
  return { query: q, provider: "fallback", items: [], warning: "No-key fallbacks returned no results (network/CORS?)." };
}

async function toolAIPipeProxy({ prompt, model = 'openai/gpt-4o-mini', max_tokens = 200 }) {
  const { apiKey, provider } = getSettings();
  let key = apiKey;
  if (!key && provider === 'aipipe') {
    try {
      const mod = await import('https://aipipe.org/aipipe.js');
      const profile = mod?.getProfile?.();
      if (profile?.token) key = profile.token;
    } catch {}
  }
  if (!key) return { error: 'AI Pipe token required (use Provider: AI Pipe or log in via AI Pipe).' };

  const url = 'https://aipipe.org/openrouter/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
  const body = { model, messages: [{ role: 'user', content: prompt }], max_tokens };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) return { error: `AI Pipe error: ${res.status} ${res.statusText}`, detail: await res.text() };
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return { text };
}

// JS sandbox via Worker
async function toolJsExec({ code }) {
  return new Promise((resolve) => {
    const logs = [];
    const workerCode = `
      "use strict";
      self.console = { log: (...a) => self.postMessage({ type: 'log', data: a.map(x => String(x)) }) };
      self.onmessage = async (e) => {
        try {
          const userCode = String(e.data || "");
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const fn = new AsyncFunction('console', '"use strict";\\n' + userCode);
          const result = await fn(console);
          self.postMessage({ type: 'done', result });
        } catch (err) {
          self.postMessage({ type: 'error', error: String(err && err.message ? err.message : err) });
        }
      };
    `;
    const blob   = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    worker.onmessage = (e) => {
      if (e.data?.type === 'log') logs.push(e.data.data.join(' '));
      if (e.data?.type === 'error') {
        showCode(logs, null, e.data.error);
        resolve({ logs, error: e.data.error });
        worker.terminate();
      }
      if (e.data?.type === 'done') {
        showCode(logs, e.data.result, null);
        resolve({ logs, result: e.data.result });
        worker.terminate();
      }
    };

    const safe = (code || '').replace(/<\/script>/gi, '<\\/script>');
    worker.postMessage(safe);
  });
}

function showCode(logs, result, error) {
  codeCard.classList.remove('d-none');
  const lines = [];
  if (logs?.length) { lines.push('/* console.log */'); for (const l of logs) lines.push('> ' + l); lines.push(''); }
  if (error) { lines.push('/* error */'); lines.push(String(error)); }
  else { lines.push('/* result */'); lines.push(typeof result === 'string' ? result : JSON.stringify(result, null, 2)); }
  codeOutput.textContent = lines.join('\n');
}

// -------- Wire up UI --------
$('#send').addEventListener('click', onSend);
$('#clear').addEventListener('click', () => {
  if (state.running) return;
  state.messages = []; chatEl.innerHTML = ''; codeCard.classList.add('d-none');
});
$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.messages, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'conversation.json'; a.click();
  URL.revokeObjectURL(url);
});
$('#userInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
});

// Theme toggle (page dark by default — chat card stays light)
const themeToggle = $('#themeToggle');
if (themeToggle) {
  themeToggle.addEventListener('change', () => {
    document.documentElement.setAttribute('data-bs-theme', themeToggle.checked ? 'dark' : 'light');
  });
}

// Init
window.addEventListener('DOMContentLoaded', () => { populateModelOptions(); });
$('#provider').addEventListener('change', () => { populateModelOptions(); });

async function onSend() {
  if (state.running) return;
  const ta = $('#userInput');
  const text = ta.value.trim();
  if (!text) return;

  addMessage('user', escapeHtml(text));
  state.messages.push({ role: 'user', content: text });
  ta.value = '';

  await agentLoop();
}
