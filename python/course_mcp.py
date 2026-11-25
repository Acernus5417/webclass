import json
import re
import sys
from urllib.parse import urlsplit

from DrissionPage import Chromium, ChromiumOptions
from mcp.server.fastmcp import FastMCP, Image
from requests import Session

source, port = sys.argv[1:]
sys.path.insert(0, source)
from main import DrissionPageMCP

sys.path.pop(0)
mcp = FastMCP("Webclass DrissionPageMCP", log_level="ERROR")
upstream = DrissionPageMCP()
tab = None
origin = None

# Fixed scripts read the visible interface. The MCP accepts no script or selector input.
VISIBLE = r"""
const visible = el => {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    for (let parent = el; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hidden || style.visibility !== 'visible' || style.display === 'none' ||
            Number(style.opacity) === 0) return false;
    }
    return true;
};
const label = el => (el?.innerText || el?.getAttribute('aria-label') || '').trim().slice(0, 250);
const video = () => [...document.querySelectorAll('video')].find(visible);
"""

FORM = r"""
const inspect = () => {
    const eligible = [];
    for (const form of document.forms) {
        if (!visible(form) || form.method.toLowerCase() !== 'post' ||
            new URL(form.action).origin !== location.origin || form.target && form.target !== '_self') continue;
        const submitters = [...form.querySelectorAll('button, input[type=submit]')].filter(el =>
            el.type === 'submit' && el.form === form && !el.disabled && visible(el) &&
            /^(?:提交(?:试卷|答案|练习|测验|作业)?|交卷|submit(?: answers| quiz| assessment)?)$/i.test(label(el) || el.value || '') &&
            !['formaction', 'formmethod', 'formtarget', 'formnovalidate'].some(attr => el.hasAttribute(attr))
        );
        if (submitters.length !== 1) continue;
        const sets = [...form.querySelectorAll('fieldset')].filter(visible);
        if (!sets.length || sets.length > 30) continue;
        const controls = new Set();
        const names = new Set();
        const groups = sets.map(set => {
            const question = label(set.querySelector(':scope > legend'));
            const inputs = [...set.querySelectorAll('input')].filter(el => visible(el) && !el.disabled);
            if (!question || inputs.length < 2 || inputs.length > 15 || !inputs[0].name || names.has(inputs[0].name)) return null;
            if (!['radio', 'checkbox'].includes(inputs[0].type) || inputs.some(el =>
                el.form !== form || el.type !== inputs[0].type || el.name !== inputs[0].name || controls.has(el)
            )) return null;
            const options = inputs.map(el => [...el.labels].filter(visible).map(label).join(' ').trim());
            if (options.some(option => !option) || new Set(options).size !== options.length) return null;
            names.add(inputs[0].name);
            inputs.forEach(el => controls.add(el));
            return { question, multiple: inputs[0].type === 'checkbox', options, inputs };
        });
        if (groups.some(group => !group) || [...form.elements].some(el =>
            el.tagName === 'INPUT' && el.type !== 'hidden' && el.type !== 'submit' && !controls.has(el) ||
            ['SELECT', 'TEXTAREA'].includes(el.tagName)
        )) continue;
        const questions = groups.map(({ question, multiple, options }) => ({ question, multiple, options }));
        const signature = 'form:' + JSON.stringify([location.href, form.action, questions]);
        eligible.push({ form, submit: submitters[0], questions, signature, groups });
    }
    return eligible.length === 1 ? eligible[0] : null;
};
"""


def get_origin(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("请选择可访问的课程网页。")
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def current():
    if tab is None:
        raise ValueError("请先在专用 Chrome 打开课程平台。")
    return tab


def scoped():
    target = current()
    if origin is None or get_origin(target.url) != origin:
        raise ValueError("当前标签页已离开确认的课程站点，请手动返回。")
    return target


@mcp.tool()
def open_platform(url: str) -> dict:
    """Open the selected platform in a dedicated Chrome tab."""
    global tab, origin
    get_origin(url)
    if upstream.browser is None:
        address = f"127.0.0.1:{port}"
        with Session() as client:
            client.trust_env = False
            with client.get(f"http://{address}/json/version", timeout=5) as response:
                response.raise_for_status()
                headless = "HeadlessChrome" in response.json().get("User-Agent", "")
        options = ChromiumOptions(read_file=False).set_address(address).existing_only().headless(headless)
        upstream.browser = Chromium(options)
    if tab is None:
        tab = upstream.browser.new_tab()
    origin = None
    tab.get(url, timeout=12)
    return {"title": tab.title, "url": tab.url}


@mcp.tool()
def bind_course() -> dict:
    """Bind the platform tab after the user opens their course and signs in manually."""
    global origin
    target = current()
    selected_origin = get_origin(target.url)
    if target.run_js(VISIBLE + "return [...document.querySelectorAll('input[type=password]')].some(visible);"):
        raise ValueError("当前仍是登录页面，请在 Chrome 完成登录并进入课程。")
    origin = selected_origin
    return {"title": target.title, "url": target.url}


@mcp.tool()
def snapshot(quiz: bool = False) -> dict:
    """Read visible text, playback state and visible same-site links in the confirmed tab."""
    return scoped().run_js(VISIBLE + FORM + r"""
        if ([...document.querySelectorAll('input[type=password]')].some(visible)) throw new Error('login');
        const main = document.querySelector('main,[role=main]') || document.body;
        const links = [...main.querySelectorAll('a[href]')].filter(el => visible(el) && label(el) &&
            el.origin === location.origin && el.href !== location.href && !el.hasAttribute('download') &&
            !/登出|退出|删除|logout|sign\s*out|delete/i.test(label(el) + ' ' + el.pathname))
            .slice(0, 50).map(el => ({label: label(el), url: el.href}));
        const assessment = arguments[0] ? inspect() : null;
        return {
            title: document.title, url: location.href, text: main.innerText.slice(0, 22000),
            links, video: Boolean(video()),
            form: assessment && { questions: assessment.questions, signature: assessment.signature }
        };
    """, quiz)


@mcp.tool()
def open_lesson(url: str) -> dict:
    """Follow a previously displayed same-site course link in the confirmed tab."""
    target = scoped()
    if get_origin(url) != origin:
        raise ValueError("课程链接必须位于已确认的站点。")
    target.get(url, timeout=12)
    return {"title": scoped().title}


@mcp.tool()
def video_state(play: bool = False) -> dict:
    """Start visible HTML video playback at its existing speed or read its progress."""
    return scoped().run_js(VISIBLE + r"""
        const el = video();
        if (!el) return { present: false };
        if (arguments[0] && el.paused && !el.ended) el.play().catch(() => {});
        return {
            present: true, ended: el.ended, paused: el.paused, time: el.currentTime,
            duration: Number.isFinite(el.duration) ? el.duration : null,
        };
    """, play)


@mcp.tool()
def submit_quiz(signature: str, answers: list[list[int]]) -> dict:
    """Select visible choices and click the recognized submit control for the confirmed form."""
    target = scoped()
    payload = json.dumps([signature, answers], ensure_ascii=False)
    result = target.run_js(VISIBLE + FORM + r"""
        const [signature, answers] = JSON.parse(arguments[0]);
        const data = inspect();
        if (!data || data.signature !== signature || answers.length !== data.groups.length) return { clicked: false };
        if (data.groups.some(({ inputs, multiple }, index) =>
            !answers[index].length || (!multiple && answers[index].length !== 1) ||
            answers[index].some(i => !Number.isInteger(i) || !inputs[i]) ||
            new Set(answers[index]).size !== answers[index].length
        )) return { clicked: false };
        for (const [index, { inputs }] of data.groups.entries()) {
            if (!data.form.isConnected || !data.submit.isConnected ||
                inputs.some(el => !el.isConnected || el.disabled || !visible(el))) return { clicked: false };
            for (const [i, el] of inputs.entries()) {
                const selected = answers[index].includes(i);
                if (el.checked !== selected && (selected || el.type === 'checkbox')) el.click();
            }
            if (inputs.some((el, i) => el.checked !== answers[index].includes(i))) return { clicked: false };
        }
        if (inspect()?.signature !== signature || !data.form.reportValidity()) return { clicked: false };
        setTimeout(() => {
            if (inspect()?.signature === signature && visible(data.submit) && !data.submit.disabled) data.submit.click();
        }, 0);
        return { clicked: true };
    """, payload)
    return result or {"clicked": False}


@mcp.tool()
def evidence() -> Image:
    """Capture the visible viewport of the confirmed course tab as a PNG."""
    return Image(data=scoped().get_screenshot(as_bytes="png"), format="png")


if __name__ == "__main__":
    mcp.run(transport="stdio")
