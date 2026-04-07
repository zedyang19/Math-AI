/**
 * 初中数学智能课堂 · 主逻辑
 * 功能：课件导航 + 豆包 AI 对话（流式输出）+ 语音输入 + 全屏管理
 */

// =========================================================
// 配置 & 状态
// =========================================================
const State = {
  sidebarOpen: true,
  aiPanelOpen: false,
  currentCourse: null,
  chatHistory: [],   // { role: 'user'|'assistant', content: string }
  isStreaming: false,
};

// 从 localStorage 读取设置
const Settings = {
  get apiKey()       { return localStorage.getItem('doubao_api_key') || ''; },
  get modelId()      { return localStorage.getItem('doubao_model_id') || ''; },
  get systemPrompt() {
    return localStorage.getItem('doubao_system_prompt') ||
      '你是一名专业的初中数学助教，名叫"豆包"。用简洁清晰的语言解释数学概念，适合初中生（13-15岁）理解。解题时展示完整步骤。数学公式使用 LaTeX 格式，行内公式用 $...$ 包裹，独立公式用 $$...$$ 包裹。回答简洁有重点。';
  },
};

// =========================================================
// DOM 引用
// =========================================================
const $ = id => document.getElementById(id);

const els = {
  sidebar:           $('sidebar'),
  sidebarToggle:     $('sidebarToggle'),
  courseList:        $('courseList'),
  placeholder:       $('placeholder'),
  courseFrame:       $('courseFrame'),
  fullscreenBtn:     $('fullscreenBtn'),
  settingsBtn:       $('settingsBtn'),
  settingsModal:     $('settingsModal'),
  settingsClose:     $('settingsClose'),
  settingsSave:      $('settingsSave'),
  apiKeyInput:       $('apiKeyInput'),
  modelInput:        $('modelInput'),
  systemPromptInput: $('systemPromptInput'),
  doubaoOrb:         $('doubaoOrb'),
  orbRing:           $('orbRing'),
  orbLabel:          $('orbLabel'),
};

// =========================================================
// 课件目录渲染
// =========================================================
async function loadCourseList() {
  try {
    const res = await fetch('courses.json');
    const data = await res.json();
    renderCourseList(data);
  } catch (e) {
    els.courseList.innerHTML =
      '<div style="padding:16px;color:#5a607a;font-size:0.85rem;">暂无课件，请添加 courses.json</div>';
  }
}

function renderCourseList(chapters) {
  els.courseList.innerHTML = '';
  chapters.forEach(chapter => {
    // 章节标题
    const chDiv = document.createElement('div');
    chDiv.className = 'course-chapter';
    chDiv.textContent = chapter.title;
    els.courseList.appendChild(chDiv);

    // 课件条目
    chapter.items.forEach(item => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'course-item';
      itemDiv.dataset.src = item.src;
      itemDiv.innerHTML = `<span class="course-item-icon">${item.icon || '📄'}</span><span>${item.title}</span>`;
      itemDiv.addEventListener('click', () => openCourse(item, itemDiv));
      els.courseList.appendChild(itemDiv);
    });
  });
}

function openCourse(item, el) {
  // 清除之前的 active
  document.querySelectorAll('.course-item.active').forEach(e => e.classList.remove('active'));
  el.classList.add('active');

  els.placeholder.classList.add('hidden');
  els.courseFrame.classList.remove('hidden');
  els.courseFrame.src = item.src;
  State.currentCourse = item;
}

// =========================================================
// 侧边栏切换
// =========================================================
function toggleSidebar() {
  State.sidebarOpen = !State.sidebarOpen;
  els.sidebar.classList.toggle('collapsed', !State.sidebarOpen);
}

// =========================================================
// 圆形头像状态管理
// =========================================================
function setOrbState(state) {
  const labels = { idle:'问豆包', listening:'正在聆听…', thinking:'思考中…', speaking:'正在回答…' };
  els.doubaoOrb.className = 'doubao-orb' + (state !== 'idle' ? ` ${state}` : '');
  els.orbRing.className   = 'orb-ring'   + (state !== 'idle' ? ` ${state}` : '');
  els.orbLabel.textContent = labels[state] || '问豆包';
}

// =========================================================
// AI 对话（豆包 API，兼容 OpenAI 格式）
// =========================================================

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把 markdown 简单格式 + LaTeX 转成 HTML（不引入完整 md 库） */
function renderMarkdown(text) {
  // 保护 LaTeX 块
  const blocks = [];
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    const idx = blocks.length;
    try {
      blocks.push(katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }));
    } catch { blocks.push(`<code>$$${math}$$</code>`); }
    return `\x00BLOCK${idx}\x00`;
  });
  text = text.replace(/\$((?:[^$\\]|\\.)+?)\$/g, (_, math) => {
    const idx = blocks.length;
    try {
      blocks.push(katex.renderToString(math.trim(), { displayMode: false, throwOnError: false }));
    } catch { blocks.push(`<code>$${math}$</code>`); }
    return `\x00BLOCK${idx}\x00`;
  });

  // 简单 markdown
  text = escapeHtml(text);
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/^#{1,3}\s+(.+)$/gm, '<strong>$1</strong>');
  text = text.replace(/\n/g, '<br/>');

  // 还原 LaTeX
  text = text.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[parseInt(i)]);
  return text;
}

async function sendMessage(userText) {
  if (!userText.trim() || State.isStreaming) return;

  const apiKey = Settings.apiKey;
  const modelId = Settings.modelId;

  if (!apiKey || !modelId) {
    showToast('请先在设置中填写 API Key 和模型 ID');
    openSettings();
    return;
  }

  State.chatHistory.push({ role: 'user', content: userText });
  State.isStreaming = true;
  setOrbState('thinking');

  // 构造消息列表（带 system prompt）
  const messages = [
    { role: 'system', content: Settings.systemPrompt },
    ...State.chatHistory,
  ];

  let fullText = '';
  let aiContentEl = null;

  try {
    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API 错误 ${response.status}: ${err}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) fullText += delta;
        } catch { /* 忽略解析错误 */ }
      }
    }

    State.chatHistory.push({ role: 'assistant', content: fullText });
    // 朗读回复
    setOrbState('speaking');
    TTS.speak(fullText, () => setOrbState('idle'));

  } catch (err) {
    setOrbState('idle');
    showToast(`请求失败：${err.message.slice(0, 40)}`);
    console.error('AI 请求失败:', err);
  } finally {
    State.isStreaming = false;
  }
}

// =========================================================
// 语音输入（Web Speech API）
// =========================================================
const Voice = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = false;
  rec.interimResults = true;

  let active = false;
  let transcript = '';

  rec.onstart = () => {
    active = true;
    transcript = '';
    setOrbState('listening');
  };

  rec.onresult = (e) => {
    transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) transcript += e.results[i][0].transcript;
    }
  };

  rec.onend = () => {
    active = false;
    if (transcript.trim()) {
      sendMessage(transcript.trim());
    } else {
      setOrbState('idle');
    }
  };

  rec.onerror = (e) => {
    active = false;
    setOrbState('idle');
    const msg = e.error === 'not-allowed' ? '麦克风权限被拒绝，请允许浏览器使用麦克风' : `语音识别错误：${e.error}`;
    showToast(msg);
  };

  return {
    toggle() { active ? rec.stop() : rec.start(); },
    stop()   { if (active) rec.stop(); },
  };
})();

// =========================================================
// 语音输出（Web Speech Synthesis）
// =========================================================
const TTS = (() => {
  const synth = window.speechSynthesis;
  if (!synth) return { speak() {}, stop() {} };

  function cleanText(text) {
    text = text.replace(/\$\$?[\s\S]*?\$\$?/g, '公式');
    text = text.replace(/\\[a-zA-Z]+\{[^}]*\}/g, '');
    text = text.replace(/[#*`>]/g, '');
    return text.trim();
  }

  function getChineseVoice() {
    const voices = synth.getVoices();
    return (
      voices.find(v => v.lang === 'zh-CN' && v.name.includes('Microsoft')) ||
      voices.find(v => v.lang === 'zh-CN') ||
      voices.find(v => v.lang.startsWith('zh')) ||
      null
    );
  }

  function speak(text, onEnd) {
    synth.cancel();
    const clean = cleanText(text);
    if (!clean) { onEnd?.(); return; }

    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'zh-CN';
    utter.rate = 1.0;
    utter.pitch = 1;
    const voice = getChineseVoice();
    if (voice) utter.voice = voice;
    utter.onend   = () => onEnd?.();
    utter.onerror = () => onEnd?.();
    synth.speak(utter);
  }

  function stop() { synth.cancel(); }

  return { speak, stop };
})();

// =========================================================
// 设置弹窗
// =========================================================
function openSettings() {
  els.apiKeyInput.value = Settings.apiKey;
  els.modelInput.value = Settings.modelId;
  els.systemPromptInput.value = Settings.systemPrompt;
  els.settingsModal.classList.remove('hidden');
}

function closeSettings() {
  els.settingsModal.classList.add('hidden');
}

function saveSettings() {
  localStorage.setItem('doubao_api_key', els.apiKeyInput.value.trim());
  localStorage.setItem('doubao_model_id', els.modelInput.value.trim());
  localStorage.setItem('doubao_system_prompt', els.systemPromptInput.value.trim());
  closeSettings();
  showToast('设置已保存');
}

// =========================================================
// 全屏
// =========================================================
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    document.body.classList.add('fullscreen');
  } else {
    document.exitFullscreen().catch(() => {});
    document.body.classList.remove('fullscreen');
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    document.body.classList.remove('fullscreen');
  }
});

// =========================================================
// Toast 提示
// =========================================================
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('hide');
    setTimeout(() => t.remove(), 300);
  }, 2500);
}

// =========================================================
// 事件绑定
// =========================================================
function bindEvents() {
  // 侧边栏
  els.sidebarToggle.addEventListener('click', toggleSidebar);

  // AI 面板
  els.aiFab.addEventListener('click', openAiPanel);
  els.aiPanelClose.addEventListener('click', closeAiPanel);

  // 发送消息
  els.aiSend.addEventListener('click', () => {
    const text = els.aiInput.value.trim();
    if (text) { els.aiInput.value = ''; autoResizeInput(); sendMessage(text); }
  });

  els.aiInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = els.aiInput.value.trim();
      if (text) { els.aiInput.value = ''; autoResizeInput(); sendMessage(text); }
    }
  });

  els.aiInput.addEventListener('input', autoResizeInput);

  // 快捷指令
  els.quickPrompts.addEventListener('click', e => {
    const btn = e.target.closest('.quick-btn');
    if (btn) {
      const prompt = btn.dataset.prompt;
      sendMessage(prompt);
    }
  });

  // 清空对话
  els.clearChatBtn.addEventListener('click', () => {
    State.chatHistory = [];
    els.aiMessages.innerHTML = `
      <div class="message ai-message">
        <div class="message-content">对话已清空，随时可以继续提问！</div>
      </div>`;
  });

  // 设置
  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsClose.addEventListener('click', closeSettings);
  els.settingsSave.addEventListener('click', saveSettings);
  els.settingsModal.addEventListener('click', e => {
    if (e.target === els.settingsModal) closeSettings();
  });

  // 全屏
  els.fullscreenBtn.addEventListener('click', toggleFullscreen);

  // 麦克风按钮
  if (Voice) {
    els.micBtn.addEventListener('click', () => {
      if (!State.aiPanelOpen) openAiPanel();
      Voice.toggle();
    });
  } else {
    els.micBtn.title = '当前浏览器不支持语音识别（请用 Chrome）';
    els.micBtn.style.opacity = '0.4';
    els.micBtn.style.cursor = 'not-allowed';
  }

  // 圆形头像按钮 → 点击开始/停止语音
  els.doubaoOrb.addEventListener('click', () => {
    if (State.isStreaming) { TTS.stop(); setOrbState('idle'); return; }
    if (!Voice) { showToast('当前浏览器不支持语音识别，请用 Edge 或 Chrome'); return; }
    Voice.toggle();
  });

  // 键盘快捷键
  document.addEventListener('keydown', e => {
    if (e.altKey && e.key === 's') { e.preventDefault(); toggleSidebar(); }
    if (e.altKey && e.key === 'a') { e.preventDefault(); if (Voice) Voice.toggle(); }
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
    if (e.key === 'Escape') {
      if (!els.settingsModal.classList.contains('hidden')) closeSettings();
      else { Voice?.stop(); TTS.stop(); setOrbState('idle'); }
    }
  });
}

// =========================================================
// KaTeX 初始化（供 HTML onload 调用）
// =========================================================
window.initKaTeX = function() {
  // 已通过 renderMarkdown 手动渲染，无需全局 auto-render
};

// =========================================================
// 启动
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  loadCourseList();
  bindEvents();

  // 若未设置 API Key，启动时提示
  if (!Settings.apiKey) {
    setTimeout(() => showToast('请点击右上角 ⚙ 设置 API Key'), 1000);
  }
});
