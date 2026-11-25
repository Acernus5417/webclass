import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { bootstrap, findPlatform, platformUrl, PREFIX } from '../lib/model.js';
import { CourseWorkflow } from '../lib/workflow.js';

function modelContext(replies, calls) {
  const sessions = [];
  return {
    sessions,
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    sessionController: {
      async create(request) {
        const sessionId = `mock-${sessions.length + 1}`;
        sessions.push({ request, sessionId });
        return { sessionId };
      },
      async rename() {},
    },
    llm: {
      async prepareCall(config) {
        return {
          config,
          async *stream(options) {
            calls.push(options);
            const text = replies.shift();
            yield { type: 'reasoning-delta', text: PREFIX, index: 0 };
            yield { type: 'text-delta', text: text.slice(0, 6), index: 1 };
            yield { type: 'block-end', block: { type: 'text', text }, index: 1 };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    },
  };
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-webclass-test-'));
  t.after(async () => {
    const actual = await realpath(path);
    assert.equal(dirname(actual), await realpath(tmpdir()));
    assert.ok(basename(actual).startsWith('dsh-webclass-test-'));
    await rm(actual, { recursive: true, force: true });
  });
  return path;
}

test('initialization sends the opaque file without tools and creates a distinct session for every mismatch', async t => {
  const workspace = await directory(t);
  const promptFile = join(workspace, 'fixture.txt');
  const prompt = '\uFEFF测试文本\r\n多行';
  await writeFile(promptFile, prompt);
  const calls = [];
  const ctx = modelContext([` ${PREFIX}错误开头`, '无前缀', `${PREFIX}你好`], calls);
  const states = [];
  const session = await bootstrap(ctx, {
    promptFile, workspace, attempts: 3, signal: new AbortController().signal,
    update: values => states.push(values),
  });
  assert.equal(session, 'mock-3');
  assert.equal(ctx.sessions.length, 3);
  assert.deepEqual(calls.map(call => call.sessionId), ['mock-1', 'mock-2', 'mock-3']);
  for (const call of calls) {
    assert.equal(call.messages[0].content[0].text, prompt);
    assert.equal(call.tools, undefined);
    assert.equal(call.system, undefined);
  }
  assert.equal(states.at(-1).reply, `${PREFIX}你好`);
});

test('platform input resolves a platform name and rejects a local or credentialed URL', async () => {
  const ctx = {};
  assert.equal((await findPlatform(ctx, '学习通', new AbortController().signal))[0].url, 'https://www.chaoxing.com/');
  assert.equal(platformUrl('www.icourse163.org'), 'https://www.icourse163.org/');
  assert.equal(platformUrl('https://user:secret@platform.org'), null);
  assert.equal(platformUrl('http://127.0.0.1:7891'), null);
});

test('course mode controls submission and retains the requested report files', async t => {
  const workspace = await directory(t);
  const calls = [];
  const ctx = modelContext([
    '{"answers":[{"question":0,"choices":[1]}]}',
    '{"answers":[{"question":0,"choices":[1]}]}',
  ], calls);
  const mcpCalls = [];
  const page = {
    title: '模拟课程', url: 'https://platform.org/course?session=private',
    text: '完成度 50%\n成绩 80 分', links: [], video: false,
    form: { signature: 'fixture', questions: [{ question: '1+1', options: ['1', '2'], multiple: false }] },
  };
  const mcp = {
    async call(method, args) {
      mcpCalls.push({ method, args });
      if (method === 'evidence') return { mime: 'image/png', data: 'cG5n' };
      if (method === 'submit_quiz') return { clicked: true };
      return page;
    },
  };
  for (const mode of ['read', 'limited', 'full']) {
    const flow = new CourseWorkflow(ctx, workspace, new AbortController().signal);
    flow.setMcp(mcp);
    flow.ready('mock');
    await flow.action('platform', { value: page.url });
    await flow.action('select', { index: 0 });
    await flow.action('login', { method: 'guest' });
    await flow.action('mode', { mode });
    await flow.action('bind', {});
    await flow.action('study', { indices: [], play: false });
    await flow.action('quiz', { submit: true });
    assert.equal(flow.state.quizzes.length, mode === 'read' ? 0 : 1);
    await flow.action('finish', {});
    assert.equal(flow.state.stage, 'done', flow.state.error);
    assert.deepEqual(flow.state.report.progress, ['完成度 50%']);
    const report = await readFile(flow.output.get('report').path, 'utf8');
    assert.ok(report.includes('成绩 80 分'));
    assert.ok(!report.includes('session=private'));
    assert.equal(flow.output.has('answers'), mode !== 'read');
  }
  assert.deepEqual(mcpCalls.filter(call => call.method === 'submit_quiz'), [
    { method: 'submit_quiz', args: { signature: 'fixture', answers: [[1]] } },
  ]);
});
