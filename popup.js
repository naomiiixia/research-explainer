const HINTS = {
  openai: 'OpenAI: starts with sk-… · Get it at platform.openai.com',
  claude: 'Anthropic: starts with sk-ant-… · Get it at console.anthropic.com'
};

document.addEventListener('DOMContentLoaded', async () => {
  const { apiKey = '', apiProvider = 'openai', customPrompt = '', defaultLang = 'zh' } =
    await chrome.storage.sync.get(['apiKey', 'apiProvider', 'customPrompt', 'defaultLang']);

  const providerEl = document.getElementById('provider');
  const apiKeyEl = document.getElementById('apiKey');
  const promptEl = document.getElementById('customPrompt');
  const langEl = document.getElementById('defaultLang');
  const statusEl = document.getElementById('status');
  const hintEl = document.getElementById('keyHint');

  providerEl.value = apiProvider;
  apiKeyEl.value = apiKey;
  promptEl.value = customPrompt;
  langEl.value = defaultLang;

  providerEl.addEventListener('change', () => {
    hintEl.textContent = HINTS[providerEl.value] || '';
  });

  document.getElementById('save').addEventListener('click', async () => {
    const key = apiKeyEl.value.trim();
    if (!key) {
      showStatus('Please enter an API key.', true);
      return;
    }

    await chrome.storage.sync.set({
      apiKey: key,
      apiProvider: providerEl.value,
      customPrompt: promptEl.value.trim(),
      defaultLang: langEl.value
    });

    showStatus('Saved!');
  });

  function showStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (isError ? ' error' : '');
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'status';
    }, 2500);
  }
});
