import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { findPlatform, solveQuiz } from './model.js';

export const modes = {
  read: '只读刷课',
  full: '全量刷课',
  limited: '有限刷课',
};

const files = {
  report: { name: '学习报告.md', type: 'text/markdown; charset=utf-8' },
  screenshot: { name: '进度截图.png', type: 'image/png' },
  answers: { name: '参考答案.md', type: 'text/markdown; charset=utf-8' },
};

function safeUrl(address) {
  const url = new URL(address);
  return url.origin + url.pathname;
}

function cell(text) {
  return String(text || '').replace(/[\r\n|<>]/g, ' ').trim();
}

function evidenceLines(text, pattern) {
  return [...new Set(text.split('\n').map(cell).filter(line => line.length < 220 && pattern.test(line)))].slice(0, 12);
}

async function playVideo(mcp, signal) {
  await mcp.call('video_state', { play: true }, signal);
  const deadline = Date.now() + 90 * 60_000;
  let lastTime = null;
  let still = 0;
  while (Date.now() < deadline) {
    const state = await mcp.call('video_state', {}, signal);
    if (!state.present) return '未能继续观察播放器';
    if (state.ended) return '已观察到播放结束';
    still = state.time === lastTime ? still + 1 : 0;
    if (still >= 5) return state.paused ? '播放器暂停，需要手动操作' : '播放器暂未推进';
    lastTime = state.time;
    await delay(3000, undefined, { signal });
  }
  return '已停止等待长视频';
}

export class CourseWorkflow {
  state = {
    stage: 'initializing', attempt: 0, attempts: 0, reply: '', runtime: 'preparing',
    busy: '', error: '', candidates: [], lessons: [], links: [], quizzes: [],
  };

  #mcp;
  #controller;
  #submissionKeys = new Set();
  #outputs = new Map();
  #course;
  #sessionId;

  constructor(ctx, workspace, lifetime) {
    this.ctx = ctx;
    this.workspace = workspace;
    this.lifetime = lifetime;
  }

  update(values) {
    Object.assign(this.state, values);
  }

  reset(workspace) {
    this.workspace = workspace;
    this.#course = undefined;
    this.#sessionId = undefined;
    this.#submissionKeys.clear();
    this.#outputs.clear();
    this.update({
      stage: 'initializing', attempt: 0, reply: '', error: '', candidates: [], lessons: [],
      links: [], quizzes: [], report: null, selected: null, mode: null, taskNotice: '', courseTitle: '',
    });
  }

  ready(sessionId) {
    this.#sessionId = sessionId;
    this.update({ stage: 'platform' });
  }

  setMcp(mcp) {
    this.#mcp = mcp;
    this.update({ runtime: 'ready', runtimeError: '' });
  }

  cancel() {
    this.#controller?.abort(new Error('已停止本次操作。'));
  }

  get output() {
    return this.#outputs;
  }

  async action(action, data) {
    if (this.state.busy || this.state.stage === 'initializing') throw new Error('上一个操作仍在进行。');
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime, controller.signal]);
    this.#controller = controller;
    this.update({ busy: action, error: '' });
    try {
      await this.#perform(action, data, signal);
    } catch (error) {
      this.update({ error: String(error.message ?? error).slice(0, 650) });
    } finally {
      this.#controller = undefined;
      this.update({ busy: '' });
    }
  }

  async #perform(action, data, signal) {
    const state = this.state;
    if (action === 'platform' && state.stage === 'platform') {
      const input = typeof data.value === 'string' ? data.value.trim() : '';
      if (!input || input.length > 1000) throw new Error('请输入平台名称或网址。');
      this.update({ candidates: [] });
      this.update({ candidates: await findPlatform(this.ctx, input, signal) });
      return;
    }
    if (action === 'select' && state.stage === 'platform') {
      const selected = Number.isInteger(data.index) && state.candidates[data.index];
      if (!selected) throw new Error('请选择一个已列出的网址。');
      this.update({ selected, stage: 'login' });
      return;
    }
    if (action === 'back' && ['login', 'mode'].includes(state.stage)) {
      this.update({ stage: state.stage === 'mode' ? 'login' : 'platform' });
      return;
    }
    if (action === 'mode' && state.stage === 'mode') {
      if (!Object.hasOwn(modes, data.mode)) throw new Error('请选择学习模式。');
      this.update({ mode: data.mode, stage: 'course' });
      return;
    }
    if (!this.#mcp) throw new Error('浏览器和 MCP 尚未就绪。');
    if (action === 'login' && state.stage === 'login') {
      if (!['manual', 'existing', 'guest'].includes(data.method)) throw new Error('请选择登录方式。');
      await this.#mcp.call('open_platform', { url: state.selected.url }, signal);
      this.update({ stage: 'mode', login: data.method });
      return;
    }
    if (state.stage !== 'course') throw new Error('请先完成前面的步骤。');
    if (action === 'bind') {
      this.#course = await this.#mcp.call('bind_course', {}, signal);
      this.update({ courseTitle: this.#course.title });
      await this.#refresh(signal);
      return;
    }
    if (!this.#course) throw new Error('请先确认 Chrome 中的课程页。');
    if (action === 'refresh') {
      await this.#refresh(signal);
    } else if (action === 'study') {
      await this.#study(data, signal);
    } else if (action === 'quiz' && state.mode !== 'read') {
      await this.#quiz(data, signal);
    } else if (action === 'finish') {
      await this.#finish(signal);
    } else {
      throw new Error('当前模式不可用此操作。');
    }
  }

  async #refresh(signal) {
    const snapshot = await this.#mcp.call('snapshot', {}, signal);
    this.update({ links: snapshot.links, tabTitle: snapshot.title, tabVideo: snapshot.video });
    return snapshot;
  }

  async #study(data, signal) {
    const links = this.state.links;
    if (!Array.isArray(data.indices) || data.indices.length > 20
      || data.indices.some(index => !Number.isInteger(index) || !links[index])) {
      throw new Error('请选择当前页面列出的链接，每批最多 20 项。');
    }
    const targets = [...new Set(data.indices)].map(i => links[i]);
    const record = async () => {
      const snapshot = await this.#mcp.call('snapshot', {}, signal);
      const lesson = {
        title: snapshot.title || '课程页面', url: safeUrl(snapshot.url), result: '已读取页面可见内容',
      };
      this.state.lessons.push(lesson);
      if (snapshot.video && data.play === true) {
        this.update({ taskNotice: `正在播放 ${lesson.title}` });
        lesson.result = await playVideo(this.#mcp, signal);
      } else if (snapshot.video) {
        lesson.result = '已读取页面，检测到视频';
      }
    };
    try {
      if (!targets.length) await record();
      for (const target of targets) {
        signal.throwIfAborted();
        this.update({ taskNotice: `正在访问 ${target.label}` });
        await this.#mcp.call('open_lesson', { url: target.url }, signal);
        await record();
      }
      await this.#refresh(signal);
    } finally {
      this.update({ taskNotice: '' });
    }
  }

  async #quiz(data, signal) {
    const snapshot = await this.#mcp.call('snapshot', { quiz: true }, signal);
    const maySubmit = this.state.mode === 'full' && data.submit === true;
    if (maySubmit && snapshot.form && this.#submissionKeys.has(snapshot.form.signature)) {
      throw new Error('已尝试提交该表单，请查看平台记录。');
    }
    const { notes, answers } = await solveQuiz(this.ctx, snapshot, signal, this.#sessionId);
    const record = { title: snapshot.title, url: safeUrl(snapshot.url), notes, status: '已整理参考答案' };
    this.state.quizzes.push(record);
    if (!maySubmit) return;
    if (!snapshot.form || !answers?.every(choices => choices.length > 0)) {
      record.status = '需人工核对或提交';
      return;
    }
    this.#submissionKeys.add(snapshot.form.signature);
    record.status = '已发起提交，待平台确认';
    const result = await this.#mcp.call('submit_quiz', { signature: snapshot.form.signature, answers }, signal);
    if (!result.clicked) {
      record.status = '页面已变化或表单不可提交';
      this.#submissionKeys.delete(snapshot.form.signature);
    }
  }

  async #finish(signal) {
    const snapshot = await this.#mcp.call('snapshot', {}, signal);
    const evidence = await this.#mcp.call('evidence', {}, signal);
    if ((await this.#mcp.call('snapshot', {}, signal)).url !== snapshot.url) throw new Error('截图时课程页面发生变化，请重新采集。');
    if (evidence.mime !== 'image/png' || typeof evidence.data !== 'string') throw new Error('未能取得课程页面的 PNG 截图。');
    const progress = evidenceLines(snapshot.text, /进度|完成[度率]|已完成|progress|completion/i);
    const grades = evidenceLines(snapshot.text, /成绩|得分|评分|分数|score|grade/i);
    const state = this.state;
    const heading = cell(this.#course.title || snapshot.title);
    const report = [
      '# 网课学习报告', '', `- 课程　${heading}`, `- 模式　${modes[state.mode]}`,
      `- 课程页　${safeUrl(this.#course.url)}`, `- 截图页　${safeUrl(snapshot.url)}`, '',
      '## 页面显示的完成度', '', ...(progress.length ? progress : ['截图页未显示可提取的进度。']), '',
      '## 页面显示的成绩', '', ...(grades.length ? grades : ['截图页未显示可提取的成绩。']), '',
      '## 本次操作记录', '', ...state.lessons.map(row => `- ${cell(row.title)} · ${row.result} · ${row.url}`),
      ...state.quizzes.map(row => `- ${cell(row.title)} · ${row.status} · ${row.url}`),
      '', '![课程页面截图](进度截图.png)', '',
    ].join('\n');
    const payload = {
      report,
      screenshot: Buffer.from(evidence.data, 'base64'),
    };
    if (state.quizzes.length) {
      payload.answers = '# 练习参考答案\n\n模型生成的答案可能有误。\n\n'
        + state.quizzes.map(item => `## ${cell(item.title)}\n\n${item.status}\n\n${item.notes}`).join('\n\n');
    }
    await mkdir(this.workspace, { recursive: true });
    const directory = await mkdtemp(join(this.workspace, '网课报告-'));
    const written = [];
    try {
      for (const [key, value] of Object.entries(payload)) {
        signal.throwIfAborted();
        const file = files[key];
        const path = join(directory, file.name);
        written.push(path);
        await writeFile(path, value, { flag: 'wx', signal });
        this.#outputs.set(key, { ...file, path });
      }
    } catch (error) {
      await Promise.allSettled(written.map(path => unlink(path)));
      await rmdir(directory).catch(() => {});
      this.#outputs.clear();
      throw error;
    }
    this.update({ stage: 'done', report: { directory, heading, progress, grades, files: Object.keys(payload) } });
  }
}
