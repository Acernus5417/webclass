import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { bootstrap } from './lib/model.js';
import { connectMcp, launchChrome, prepareRuntime, resolveConfig } from './lib/runtime.js';
import { CourseWorkflow } from './lib/workflow.js';

export const name = 'dsh-webclass';
export const inject = ['agentDefaultModel', 'llm', 'sessionController', 'commands'];

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error('表单内容过长。');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('表单内容错误。');
  return value;
}

const headers = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const assets = new Map([
  ['', ['panel.html', 'text/html; charset=utf-8']],
  ['panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['panel.css', ['panel.css', 'text/css; charset=utf-8']],
]);

function htmlPanel(workflow, handlers) {
  const key = `/${randomBytes(24).toString('hex')}/`;
  let authority;
  const server = createServer((request, response) => {
    const reply = (status, content, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { ...headers, 'content-type': type });
      response.end(content);
    };
    const json = (status, value) => reply(status, JSON.stringify(value), 'application/json; charset=utf-8');
    void (async () => {
      const path = request.url;
      if (request.headers.host !== authority || !path?.startsWith(key)
        || request.headers['sec-fetch-site'] === 'cross-site') {
        reply(404, '找不到页面');
        return;
      }
      const route = path.slice(key.length);
      if (request.method === 'GET' && route === 'state') {
        json(200, workflow.state);
        return;
      }
      if (request.method === 'GET' && assets.has(route)) {
        const [asset, type] = assets.get(route);
        reply(200, await readFile(new URL(`./lib/panel/${asset}`, import.meta.url)), type);
        return;
      }
      if (request.method === 'GET' && route.startsWith('files/')) {
        const item = workflow.output.get(route.slice('files/'.length));
        if (item && workflow.state.stage === 'done') {
          const file = createReadStream(item.path);
          file.once('error', () => response.destroy());
          response.writeHead(200, {
            ...headers, 'content-type': item.type,
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
          });
          file.pipe(response);
          return;
        }
      }
      if (request.method === 'POST' && route === 'action') {
        if (request.headers.origin !== `http://${authority}`
          || request.headers['content-type'] !== 'application/json') {
          reply(403, '请求来源错误');
          return;
        }
        const data = await body(request);
        const { action } = data;
        if (action === 'cancel') workflow.cancel();
        else if (action === 'retry') handlers.retry();
        else if (action === 'retry-runtime') handlers.retryRuntime();
        else if (action === 'close') {
          if (workflow.state.stage !== 'done') throw new Error('请先生成报告。');
          response.once('finish', handlers.closeBrowser);
        } else {
          void workflow.action(action, data).catch(error => workflow.update({ error: error.message }));
        }
        json(202, { accepted: true });
        return;
      }
      reply(404, '找不到页面');
    })().catch(error => {
      if (!response.headersSent) json(400, { error: String(error.message ?? error).slice(0, 450) });
      else response.destroy();
    });
  });
  return {
    async open() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      authority = `127.0.0.1:${server.address().port}`;
      return `http://${authority}${key}`;
    },
    close() { server.close(); server.closeAllConnections(); },
  };
}

export function apply(ctx, raw = {}) {
  const config = resolveConfig(raw);
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const workflow = new CourseWorkflow(ctx, config.workspace, signal);
  let started;
  let startup;
  let opening;
  let chrome;
  let mcp;
  let url;

  function init(workspace = workflow.workspace) {
    if (startup) return startup;
    workflow.reset(workspace);
    startup = bootstrap(ctx, {
      ...config, workspace, signal, update: values => workflow.update(values),
    }).then(sessionId => workflow.ready(sessionId), error => {
      if (!signal.aborted) workflow.update({
        stage: 'init-error', error: String(error.message ?? error).slice(0, 500),
      });
    }).finally(() => { startup = undefined; });
    return startup;
  }

  async function closeBrowser() {
    const currentMcp = mcp;
    const currentChrome = chrome;
    mcp = undefined;
    chrome = undefined;
    if (currentMcp) await currentMcp.close();
    if (currentChrome) await currentChrome.close();
    workflow.setMcp(undefined);
    workflow.update({ runtime: 'closed' });
  }

  function openBrowser() {
    if (opening) return opening;
    opening = (async () => {
      if (chrome && mcp) return;
      workflow.update({ runtime: 'preparing', runtimeError: '' });
      const runtime = await prepareRuntime(config, signal);
      chrome ??= await launchChrome(config, runtime.root, url, signal);
      mcp = await connectMcp(runtime, config.port, signal);
      workflow.setMcp(mcp);
    })().catch(error => {
      if (!signal.aborted) {
        const detail = String(error.message ?? error).slice(0, 500);
        workflow.update({ runtime: 'error', runtimeError: detail });
        ctx.logger.warn(`dsh-webclass: ${detail}`);
      }
    }).finally(() => { opening = undefined; });
    return opening;
  }

  const panel = htmlPanel(workflow, {
    retry: () => {
      if (workflow.state.stage === 'init-error') void init();
    },
    retryRuntime: () => { void openBrowser(); },
    closeBrowser: () => {
      void closeBrowser().catch(error => {
        workflow.update({ error: '清理 Chrome 工作目录失败，请先关闭专用 Chrome。' });
        ctx.logger.warn(`dsh-webclass: ${error.message}`);
      });
    },
  });

  function start(workspace = config.workspace) {
    if (started) return started;
    void init(workspace);
    started = panel.open().then(address => {
      url = address;
      signal.throwIfAborted();
      void openBrowser();
    }).catch(error => {
      if (!signal.aborted) ctx.logger.warn(`dsh-webclass: ${error.message}`);
    });
    return started;
  }

  ctx.commands.register({
    name: 'webclass',
    description: '打开网课助手或查看报告位置',
    async handler({ agent }) {
      const cwd = agent?.session?.header?.cwd;
      if (!started) await start(typeof cwd === 'string' && isAbsolute(cwd) ? cwd : config.workspace);
      if (!url) return { kind: 'error', text: '网课向导未能启动。' };
      if (workflow.state.stage === 'done') {
        return { kind: 'success', text: `网课报告已保存到 ${workflow.state.report.directory}` };
      }
      if (!mcp) void openBrowser();
      const status = workflow.state.runtimeError || workflow.state.error;
      return { kind: 'success', text: [status, `网课向导 ${url}`].filter(Boolean).join('\n') };
    },
  });

  ctx.on('dispose', async () => {
    lifetime.abort();
    workflow.cancel();
    panel.close();
    await opening;
    await closeBrowser().catch(error => ctx.logger.warn(`dsh-webclass: ${error.message}`));
  });

  if (raw.autoStart !== false) {
    let workspace = config.workspace;
    if (!raw.workspace) {
      try {
        const known = ctx.get('workspaceRegistry')?.list() ?? [];
        if (!known.some(item => item.path === workspace)) workspace = known[0]?.path ?? workspace;
      } catch {
        // Some profiles do not mount a workspace registry at startup.
      }
    }
    void start(workspace);
  }
}
