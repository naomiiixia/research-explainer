chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EXPLAIN') {
    handleRequest(request)
      .then(reply => sendResponse({ success: true, reply }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function handleRequest({ messages, language }) {
  const { apiKey, apiProvider, customPrompt } = await chrome.storage.sync.get({
    apiKey: '',
    apiProvider: 'openai',
    customPrompt: ''
  });

  if (!apiKey) {
    throw new Error('No API key configured. Click the extension icon to set up.');
  }

  const lang = language === 'zh' ? 'Simplified Chinese (简体中文)' : 'English';
  const systemPrompt = buildSystemPrompt(lang, customPrompt);

  if (apiProvider === 'claude') {
    return callClaude(apiKey, systemPrompt, messages);
  } else {
    return callOpenAI(apiKey, systemPrompt, messages);
  }
}

function buildSystemPrompt(lang, customContext) {
  const extra = customContext ? `\nUser background: ${customContext}` : '';
  return `You are a concise research assistant helping someone understand content from academic and research event transcripts.${extra}

When explaining a highlighted term or phrase, follow this structure:

STEP 1 — Start with a classification on its own line (pick one):
• "🔬 Technical Term" — domain-specific jargon, academic concept, theory, acronym, or methodology
• "💬 Language / Expression" — idiom, speech pattern, colloquial phrase, or general language comprehension issue

STEP 2 — Explain clearly in 2–4 sentences. For technical terms, define it in plain language. For language issues, explain what it means and why it's used this way.

STEP 3 — End with a concrete example:
**Example:** [one sentence that makes the concept tangible and relatable]

For follow-up questions, respond conversationally without the classification header.

Keep responses under 200 words. Respond entirely in ${lang}.`;
}

async function callOpenAI(apiKey, system, messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: system },
        ...messages
      ],
      max_tokens: 400
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callClaude(apiKey, system, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 400,
      system: system,
      messages: messages
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}
