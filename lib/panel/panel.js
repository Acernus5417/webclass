const card = document.getElementById('card');
const status = document.getElementById('status');
const steps = document.getElementById('steps');
let previous = '';
let sending = false;
let lastError = '';

const labels = {
  platform: '平台', login: '登录', mode: '模式', course: '课程', done: '报告',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function heading(title, details) {
  card.append(element('h1', title));
  if (details) card.append(element('p', details, 'muted'));
}

function button(text, action, data = {}, config = {}) {
  const control = element('button', text, config.className);
  control.type = 'button';
  control.disabled = config.disabled ?? false;
  control.addEventListener('click', () => void post(action, typeof data === 'function' ? data() : data));
  return control;
}

function choices(selected, options, action, disabled = false) {
  const container = element('div', '', 'choices');
  for (const [value, title, description] of options) {
    const control = button(title, action, { [selected]: value }, { className: 'choice', disabled });
    if (description) control.append(element('small', description));
    container.append(control);
  }
  return container;
}

function list(items, placeholder) {
  if (!items.length) return element('p', placeholder, 'muted');
  const result = element('ul');
  for (const item of items) result.append(element('li', item));
  return result;
}

function checkbox(label, checked = false) {
  const row = element('label', '', 'check');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = checked;
  row.append(input, element('span', label));
  return { row, input };
}

function showPlatform(state) {
  heading('你在哪个平台上课？', '输入平台名称或网址。找到候选后，请确认你实际使用的入口。');
  const form = element('form');
  const input = element('input');
  input.type = 'text';
  input.setAttribute('aria-label', '平台名称或网址');
  input.placeholder = '例如 学习通 或 https://…';
  input.maxLength = 1000;
  input.required = true;
  input.value = state.selected?.label || '';
  const submit = element('button', '查找平台');
  submit.disabled = Boolean(state.busy);
  form.append(input, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void post('platform', { value: input.value.trim() });
  });
  card.append(form);
  if (state.candidates.length) {
    card.append(element('h2', '请选择平台入口'), choices('index',
      state.candidates.map((item, index) => [index, item.label, item.url]), 'select', Boolean(state.busy)));
  }
}

function showLogin(state) {
  heading('你想怎么进入平台？', state.selected.url);
  card.append(choices('method', [
    ['manual', '在 Chrome 中手动登录', '可使用账号密码、扫码或平台提供的单点登录。'],
    ['existing', '使用此窗口中的现有登录', '适合已经在专用 Chrome 窗口登录的情况。'],
    ['guest', '以访客身份继续', '适合公开课程。'],
  ], 'login', Boolean(state.busy) || state.runtime !== 'ready'));
  card.append(button('返回平台选择', 'back', {}, { className: 'plain row', disabled: Boolean(state.busy) }));
}

function showMode(state) {
  heading('这次采用哪种学习模式？', '请在另一个 Chrome 标签页完成登录，再进入你要处理的课程。');
  card.append(choices('mode', [
    ['read', '只读刷课', '读取课程页面，可按正常速度播放可见视频。'],
    ['full', '全量刷课', '同时整理练习答案，可在页面明确请求自动提交。答案可能有误。'],
    ['limited', '有限刷课', '同时整理练习参考答案，并随报告保存到工作区。'],
  ], 'mode'));
  card.append(button('返回登录方式', 'back', {}, { className: 'plain row' }));
}

function showCourse(state) {
  heading(state.courseTitle || '已打开你的课程页吗？', state.courseTitle
    ? '可继续在课程标签页导航。回到向导后刷新页面信息。'
    : '在课程标签页进入课程首页，然后回到这里确认。');
  const disabled = Boolean(state.busy) || state.runtime !== 'ready';
  if (!state.courseTitle) {
    card.append(button('确认当前课程页', 'bind', {}, { disabled }));
    return;
  }
  if (state.tabTitle) card.append(element('p', `当前页面　${state.tabTitle}`, 'muted'));
  if (state.links.length) card.append(element('h2', '要处理哪些章节？'));
  const picked = [];
  if (state.links.length) {
    const options = element('div', '', 'scroll');
    state.links.forEach((item, index) => {
      const { row, input } = checkbox(item.label);
      input.disabled = disabled;
      picked.push([index, input]);
      options.append(row);
    });
    card.append(options);
  }
  const play = checkbox('播放页面上可见的视频并等待结束', true);
  play.input.disabled = disabled;
  card.append(play.row);
  const row = element('div', '', 'row');
  row.append(
    button('处理当前页或所选章节', 'study', () => ({
      indices: picked.filter(([, input]) => input.checked).map(([index]) => index),
      play: play.input.checked,
    }), { disabled }),
    button('刷新页面信息', 'refresh', {}, { className: 'plain', disabled }),
  );
  if (state.busy) row.append(button('停止当前操作', 'cancel', {}, { className: 'plain' }));
  card.append(row);
  if (state.mode !== 'read') {
    card.append(element('h2', '当前页是练习吗？'));
    const row = element('div', '', 'row');
    row.append(button('整理参考答案', 'quiz', {}, { className: 'plain', disabled }));
    if (state.mode === 'full') {
      const confirmation = checkbox('我确认可提交当前练习，并接受答案可能有误。');
      const submit = button('答题并尝试自动提交', 'quiz', { submit: true }, { disabled: true });
      confirmation.input.disabled = disabled;
      confirmation.input.addEventListener('change', () => { submit.disabled = !confirmation.input.checked; });
      row.append(confirmation.row, submit);
    }
    card.append(row);
  }
  if (state.lessons.length || state.quizzes.length) {
    const details = element('details');
    details.append(element('summary', '查看本次学习记录'), list([
      ...state.lessons.map(row => `${row.title} · ${row.result}`),
      ...state.quizzes.map(row => `${row.title} · ${row.status}`),
    ]));
    card.append(details);
  }
  card.append(
    element('h2', '可以生成报告了吗？'),
    element('p', '请先在课程标签页打开完成度或成绩页。截图会记录该页面。', 'muted'),
    button('采集截图并生成报告', 'finish', {}, { className: 'plain', disabled }),
  );
}

function showReport(state) {
  heading('报告已生成', state.report.directory);
  card.append(element('h2', '页面显示的完成度'), list(state.report.progress, '当前截图页未显示完成度。'));
  card.append(element('h2', '页面显示的成绩'), list(state.report.grades, '当前截图页未显示成绩。'));
  const downloads = { report: '学习报告', screenshot: '进度截图', answers: '参考答案' };
  const row = element('div', '', 'row');
  for (const file of state.report.files) {
    const link = element('a', downloads[file], 'download');
    link.href = `files/${file}`;
    link.download = '';
    row.append(link);
  }
  card.append(row, button('清理临时文件并关闭专用 Chrome', 'close', {}, { className: 'plain row' }));
}

function render(state) {
  const statusText = [lastError, state.error, state.runtimeError, state.taskNotice,
    state.busy && !state.taskNotice ? '操作正在进行…' : ''].filter(Boolean).join('　');
  status.textContent = statusText;
  const stable = JSON.stringify(state);
  if (stable === previous) return;
  previous = stable;
  card.replaceChildren();
  steps.replaceChildren();
  for (const [id, label] of Object.entries(labels)) {
    const step = element('span', label);
    if (state.stage === id) step.setAttribute('aria-current', 'step');
    steps.append(step);
  }
  if (state.stage === 'initializing') {
    heading('正在初始化模型', state.attempt ? `第 ${state.attempt} 次会话 · 最多 ${state.attempts} 次` : '正在等待模型就绪。');
  } else if (state.stage === 'init-error') {
    heading('初始化需要重试', '请检查 DSH 模型配置和提示词路径，再开启新的会话。');
    card.append(button('重新初始化', 'retry'));
  } else if (state.stage === 'platform') showPlatform(state);
  else if (state.stage === 'login') showLogin(state);
  else if (state.stage === 'mode') showMode(state);
  else if (state.stage === 'course') showCourse(state);
  else if (state.stage === 'done') showReport(state);
  if (state.runtime === 'error') card.append(button('重试浏览器连接', 'retry-runtime', {}, { className: 'plain row' }));
  if (state.reply && ['init-error', 'platform'].includes(state.stage)) {
    const details = element('details');
    details.append(element('summary', '查看模型回复'), element('pre', state.reply));
    card.append(details);
  }
}

async function refresh() {
  try {
    const response = await fetch('state');
    if (!response.ok) throw new Error('无法读取向导状态。');
    render(await response.json());
  } catch {
    status.textContent = '向导连接已断开。请检查 DSH 是否运行。';
  }
}

async function post(action, data) {
  if (sending) return;
  sending = true;
  lastError = '';
  try {
    const response = await fetch('action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, action }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || '操作未能开始。');
    }
  } catch (error) {
    lastError = error.message;
  } finally {
    sending = false;
    await refresh();
  }
}

void refresh();
setInterval(refresh, 1150);
