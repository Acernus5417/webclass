import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const pythonDir = fileURLToPath(new URL('../python/', import.meta.url));
const bundledPrompt = fileURLToPath(new URL('../assets/bootstrap.txt', import.meta.url));
const onWindows = process.platform === 'win32';
const envPython = path => join(path, onWindows ? 'Scripts/python.exe' : 'bin/python');
const archiveRevision = 'dd442717ff745ef46c6a71d19cfda9f2728efee6';
const archiveHash = 'c13382ae4d34ac4e2314c7b85e82933fd33ca7996e4988e26a88b14e24ba9a42';
const uvVersion = '0.13.0';
const pythonRequirements = [
  'DrissionPage==4.1.0.18',
  'mcp==1.9.0',
  'fastmcp==2.4.0',
  // MCP 1.9.0 uses a Pydantic helper that was removed in 2.14.
  'pydantic==2.11.9',
];

async function exists(path) {
  if (!path) return false;
  return access(path).then(() => true, () => false);
}

async function firstFile(paths) {
  for (const path of paths) if (await exists(path)) return path;
}

async function run(command, args, signal, detail) {
  signal.throwIfAborted();
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { signal, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(detail)));
  });
}

async function digest(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, limit, signal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  if (!response.ok || !response.body) throw new Error(`下载运行依赖失败（HTTP ${response.status}）。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('下载文件超过允许的大小。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function verifiedBytes(bytes, sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('运行依赖的 SHA-256 校验失败。');
  }
  return bytes;
}

async function mcpArchive(config, root, signal) {
  if (config.archive) return config.archive;
  const path = join(root, `DrissionPageMCP-${archiveRevision}.zip`);
  if (await exists(path) && await digest(path, signal) === archiveHash) return path;
  const url = `https://codeload.github.com/wxhzhwxhzh/DrissionPageMCP/zip/${archiveRevision}`;
  const bytes = verifiedBytes(await download(url, 3_000_000, signal), archiveHash);
  const temporary = `${path}.${randomUUID()}.download`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', signal, mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

async function uvExecutable(config, root, signal) {
  if (config.uvPath && !await exists(config.uvPath)) throw new Error('配置的 uv 文件不存在。');
  const program = onWindows ? 'uv.exe' : 'uv';
  const local = await firstFile([config.uvPath,
    join(homedir(), '.local', 'bin', program),
    join(homedir(), '.cargo', 'bin', program),
    ...String(process.env.PATH ?? '').split(onWindows ? ';' : ':').filter(Boolean).map(dir => join(dir, program)),
  ]);
  if (local) return local;
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const os = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[process.platform];
  if (!cpu || !os) throw new Error('当前系统需要通过 uvPath 指定已有的 uv。');
  const target = `${cpu}-${os}`;
  const asset = `uv-${target}.${onWindows ? 'zip' : 'tar.gz'}`;
  const folder = join(root, `uv-${uvVersion}-${target}`);
  const result = await firstFile([join(folder, program), join(folder, `uv-${target}`, program)]);
  if (result) return result;
  const url = `https://github.com/astral-sh/uv/releases/download/${uvVersion}/${asset}`;
  const [checksum, bytes] = await Promise.all([
    download(`${url}.sha256`, 4096, signal),
    download(url, 55_000_000, signal),
  ]);
  verifiedBytes(bytes, checksum.toString('ascii').trim().split(/\s+/)[0]);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const archive = join(folder, `${randomUUID()}-${asset}`);
  try {
    await writeFile(archive, bytes, { flag: 'wx', signal, mode: 0o600 });
    await run('tar', ['-xf', archive, '-C', folder], signal, '无法解压 uv 发布包，请检查系统的 tar 命令。');
  } finally {
    await rm(archive, { force: true });
  }
  const executable = await firstFile([join(folder, program), join(folder, `uv-${target}`, program)]);
  if (!executable) throw new Error('uv 发布包缺少可执行文件。');
  return executable;
}

async function removeOwnedDirectory(root, directory, prefix) {
  if (!await exists(directory)) return;
  const [parent, target] = await Promise.all([realpath(root), realpath(directory)]);
  if (relative(parent, dirname(target)) !== '' || !basename(target).startsWith(prefix)
    || basename(target) !== basename(directory)) {
    throw new Error('运行目录的位置发生变化，已停止清理。');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
}

export async function prepareRuntime(config, signal) {
  const root = config.runtimeDirectory;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const archive = await mcpArchive(config, root, signal);
  const id = (await digest(archive, signal)).slice(0, 20);
  const install = join(root, `mcp-${id}`);
  const done = join(install, 'installed');
  const source = join(install, 'source');
  const sideBySide = config.archive
    ? envPython(join(dirname(config.archive), 'DrissionPageMCP', 'DrissionPageMCP-master', '.venv'))
    : undefined;
  const local = await firstFile([config.pythonPath, process.env.DSH_WEBCLASS_PYTHON, sideBySide]);
  if (config.pythonPath && !await exists(config.pythonPath)) throw new Error('配置的 Python 文件不存在。');
  const python = local ?? envPython(join(install, 'venv'));
  const installed = await readFile(done, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const expected = local ? id : pythonRequirements.join('\n');
  if (installed === null || !await exists(python) || (!local && installed !== expected)) {
    await mkdir(install, { recursive: true, mode: 0o700 });
    if (!local) {
      const uv = await uvExecutable(config, root, signal);
      if (!await exists(python)) {
        await run(uv, ['venv', '--python', '3.13', join(install, 'venv')], signal, '无法创建 Python 3.13 环境。请检查 uv 和网络。');
      }
      await run(uv, ['pip', 'install', '--python', python, ...pythonRequirements],
        signal, 'MCP Python 依赖安装失败，请检查网络和 uv。');
    }
    await run(python, ['-I', '-B', '-c', 'import DrissionPage; from mcp.server.fastmcp import FastMCP'],
      signal, '无法导入 DrissionPage 或 MCP，请检查所配置 Python 的依赖。');
    if (installed === null) {
      await removeOwnedDirectory(install, source, 'source');
      await mkdir(source, { mode: 0o700 });
      await run(python, ['-I', '-B', join(pythonDir, 'install.py'), archive, source], signal, '无法安装 DrissionPageMCP 压缩包。');
    }
    await writeFile(done, expected, { mode: 0o600 });
  }
  return { root, source, python };
}

async function chromeExecutable(config) {
  if (config.chromePath) {
    if (!await exists(config.chromePath)) throw new Error('配置的 Chrome 文件不存在。');
    return config.chromePath;
  }
  const paths = onWindows ? [
    ...[join(homedir(), 'AppData', 'Local'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter(Boolean).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  ];
  const path = await firstFile(paths);
  if (!path) throw new Error('找不到 Chrome，请在插件配置中填写 chromePath。');
  return path;
}

async function checkPort(port, signal) {
  signal.throwIfAborted();
  const server = createServer();
  await new Promise((resolveCheck, reject) => {
    server.once('error', () => reject(new Error(`Chrome 调试端口 ${port} 无法使用，插件未连接已有浏览器。`)));
    server.listen(port, '127.0.0.1', () => server.close(resolveCheck));
  });
}

function untilExit(child) {
  return new Promise(resolveExit => {
    child.once('error', resolveExit);
    child.once('exit', resolveExit);
  });
}

export async function launchChrome(config, root, panelUrl, signal) {
  await checkPort(config.port, signal);
  const chrome = await chromeExecutable(config);
  const profile = await mkdtemp(join(root, 'chrome-'));
  const child = spawn(chrome, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${config.port}`,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', panelUrl,
  ], { stdio: 'ignore', windowsHide: false });
  const exited = untilExit(child);
  let stopped = false;
  void exited.then(() => { stopped = true; });
  const close = async () => {
    if (!stopped) child.kill();
    await exited;
    await removeOwnedDirectory(root, profile, 'chrome-');
  };
  try {
    for (let i = 0; i < 35; i++) {
      signal.throwIfAborted();
      if (stopped) break;
      const response = await fetch(`http://127.0.0.1:${config.port}/json/version`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(400)]),
      }).catch(() => null);
      if (response?.ok && /^Chrome\//.test((await response.json()).Browser ?? '')) return { close };
      await delay(260, undefined, { signal });
    }
    throw new Error('Chrome 启动后未能建立本地连接。');
  } catch (error) {
    await close();
    throw error;
  }
}

class StdioMcp {
  #id = 0;
  #pending = new Map();
  #closed = false;

  constructor(runtime, port) {
    const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
    this.child = spawn(runtime.python, [
      '-I', '-B', join(pythonDir, 'course_mcp.py'), runtime.source, String(port),
    ], {
      cwd: runtime.source, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy },
    });
    this.exited = untilExit(this.child);
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new Error('MCP 协议请求失败。'));
      else pending.resolve(message.result);
    });
    void this.exited.then(() => {
      this.#closed = true;
      for (const pending of this.#pending.values()) pending.reject(new Error('DrissionPage MCP 进程已退出。'));
    });
  }

  async request(method, params, signal, timeout = 25_000) {
    if (this.#closed) throw new Error('DrissionPage MCP 已关闭。');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    deadline.throwIfAborted();
    const id = ++this.#id;
    return await new Promise((resolveResponse, rejectResponse) => {
      const settle = callback => value => {
        this.#pending.delete(id);
        deadline.removeEventListener('abort', onAbort);
        callback(value);
      };
      const resolve = settle(resolveResponse);
      const reject = settle(rejectResponse);
      const onAbort = () => reject(deadline.reason);
      deadline.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error) reject(new Error('无法向 DrissionPage MCP 发送请求。'));
      });
    });
  }

  async call(name, args, signal) {
    const response = await this.request('tools/call', { name, arguments: args }, signal);
    const content = response.content ?? [];
    if (response.isError) throw new Error(String(content[0]?.text ?? '浏览器操作失败。').slice(0, 450));
    if (response.structuredContent) return response.structuredContent;
    if (content[0]?.type === 'image') return { mime: content[0].mimeType, data: content[0].data };
    return JSON.parse(content[0]?.text ?? '{}');
  }

  async close() {
    if (!this.#closed) {
      this.child.stdin.end();
      await Promise.race([this.exited, delay(800)]);
      if (!this.#closed) this.child.kill();
    }
    await this.exited;
  }
}

export async function connectMcp(runtime, port, signal) {
  const mcp = new StdioMcp(runtime, port);
  try {
    await mcp.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'dsh-webclass', version: '0.1.1' },
    }, signal);
    mcp.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await mcp.request('tools/list', {}, signal);
    return mcp;
  } catch (error) {
    await mcp.close();
    throw error;
  }
}

export function resolveConfig(input) {
  const absolute = (value, fallback) => resolve(value || fallback);
  const port = input.port ?? 7891;
  const attempts = input.attempts ?? 3;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Chrome 端口必须在 1024 至 65535 之间。');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('初始化尝试次数必须在 1 至 10 之间。');
  return {
    ...input, port, attempts,
    archive: input.archive ? resolve(input.archive) : null,
    promptFile: absolute(input.promptFile, bundledPrompt),
    workspace: absolute(input.workspace, process.cwd()),
    runtimeDirectory: absolute(input.runtimeDirectory, join(homedir(), '.dsh', 'webclass-runtime')),
  };
}
