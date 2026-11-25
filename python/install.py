import shutil
import sys
from pathlib import Path
from zipfile import ZipFile

archive, destination = map(Path, sys.argv[1:])
allowed = {
    "main.py", "ToolBox.py", "domTreeToJSON.js",
    "DrissionPage_code_guide.md", "requirements.txt", "pyproject.toml",
}
with ZipFile(archive) as source:
    selected = {}
    for entry in source.infolist():
        if entry.is_dir():
            continue
        name = entry.filename.replace("\\", "/").split("/")
        if len(name) in (1, 2) and name[-1] in allowed:
            if name[-1] in selected or entry.file_size > 4_000_000:
                raise ValueError("Duplicate or oversized MCP archive member")
            selected[name[-1]] = entry
    if not {"main.py", "ToolBox.py", "domTreeToJSON.js"} <= selected.keys():
        raise ValueError("The archive is missing DrissionPageMCP source files")
    for filename, entry in selected.items():
        with source.open(entry) as member, (destination / filename).open("xb") as target:
            shutil.copyfileobj(member, target)
