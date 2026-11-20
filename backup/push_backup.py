"""把备份包推送到 GitHub 私有仓库。

Copyright (c) 2026 ZhengWill — MIT License (见仓库根目录 LICENSE)
本文件为原创实现，无第三方代码。

走 GitHub Contents API 而不是 git push，理由：
  - 服务器不用装 git 凭据、不用配 SSH key
  - 单次 PUT 就能提交，不用处理 shallow clone
  - 3.3MB 的包远低于 API 100MB 上限

用法（在服务器上）：
  GITHUB_TOKEN=ghp_xxx python3 push_backup.py [备份包路径]
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

OWNER = os.environ.get("GITHUB_OWNER", "").strip()
REPO = os.environ.get("GITHUB_REPO", "").strip()
API = "https://api.github.com"
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()

BACKUP_DIR = os.environ.get("BACKUP_DIR", "/root/backups")


def api(method, path, payload=None, raw=False):
    url = API + path
    data = None
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dafeiyu-backup",
    }
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
            return r.status, (body if raw else json.loads(body or b"{}"))
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            j = json.loads(body or b"{}")
        except Exception:
            j = {"raw": body[:300].decode("utf-8", "replace")}
        return e.code, j


def get_sha(path):
    st, j = api("GET", f"/repos/{OWNER}/{REPO}/contents/{path}")
    if st == 200:
        return j.get("sha")
    return None


def put_file(path, content_bytes, message):
    sha = get_sha(path)
    payload = {
        "message": message,
        "content": base64.b64encode(content_bytes).decode(),
    }
    if sha:
        payload["sha"] = sha
    st, j = api("PUT", f"/repos/{OWNER}/{REPO}/contents/{path}", payload)
    return st, j


def main():
    if not TOKEN:
        print("缺少 GITHUB_TOKEN")
        return 1

    # 找最新备份
    if len(sys.argv) > 1:
        pkg = sys.argv[1]
    else:
        cands = sorted(
            (os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR)
             if f.startswith("dafeiyu-") and f.endswith(".tar.gz")),
            key=os.path.getmtime,
        )
        if not cands:
            print("找不到备份包，先跑 /root/backup.sh")
            return 1
        pkg = cands[-1]

    name = os.path.basename(pkg)
    size = os.path.getsize(pkg)
    print(f"备份包: {name} ({size/1048576:.2f} MB)")

    with open(pkg, "rb") as f:
        data = f.read()

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    msg = f"备份 {name}（{stamp}）"

    # 1) 推到 archives/<name> —— 历史归档
    st, j = put_file(f"archives/{name}", data, msg)
    print(f"  archives/{name}: HTTP {st}", "" if st in (200, 201) else j.get("message", ""))

    # 2) 更新 latest/ —— 便于新机器一键拿最新
    st2, j2 = put_file("latest/backup.tar.gz", data, f"更新 latest（{stamp}）")
    print(f"  latest/backup.tar.gz: HTTP {st2}", "" if st2 in (200, 201) else j2.get("message", ""))

    # 3) 校验和
    sumfile = pkg + ".sha256"
    if os.path.exists(sumfile):
        with open(sumfile, "rb") as f:
            sh = f.read().strip()
        st3, _ = put_file("latest/backup.tar.gz.sha256", sh, f"更新校验和（{stamp}）")
        print(f"  latest/backup.tar.gz.sha256: HTTP {st3}")

    # 4) 备份元信息
    meta = {
        "package": name,
        "bytes": size,
        "pushedAt": stamp,
        "hostname": subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip(),
        "sha256": open(sumfile).read().strip() if os.path.exists(sumfile) else None,
    }
    st4, j4 = put_file(
        "latest/info.json",
        json.dumps(meta, ensure_ascii=False, indent=2).encode(),
        f"更新元信息（{stamp}）",
    )
    print(f"  latest/info.json: HTTP {st4}")

    ok = all(s in (200, 201) for s in (st, st2, st4))
    print("完成" if ok else "部分失败，检查上面的状态码")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
