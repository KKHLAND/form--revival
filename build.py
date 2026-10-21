#!/usr/bin/env python3
"""src/ 의 조각을 합쳐 index.html 한 파일을 만듭니다. (파이썬 3만 있으면 됩니다)

    python3 build.py          # index.html 만들기
    python3 build.py --check  # index.html 이 src/ 와 맞는지만 확인
"""
import base64
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"


def build() -> str:
    app = (SRC / "app.html").read_text(encoding="utf-8")
    engine = (SRC / "engine.js").read_text(encoding="utf-8")
    metrics = (SRC / "font-metrics.json").read_text(encoding="utf-8").strip()
    skeleton = base64.b64encode((SRC / "skeleton.hwpx").read_bytes()).decode("ascii")
    for marker, text in (("/*__METRICS__*/null", engine), ("/*__ENGINE__*/", app), ("/*__SKELETON__*/", app)):
        if text.count(marker) != 1:
            sys.exit(f"표시 '{marker}' 가 정확히 한 번 있어야 합니다.")
    engine = engine.replace("/*__METRICS__*/null", metrics)
    return app.replace("/*__ENGINE__*/", engine).replace("/*__SKELETON__*/", skeleton)


if __name__ == "__main__":
    out = build()
    target = ROOT / "index.html"
    if "--check" in sys.argv:
        same = target.exists() and target.read_text(encoding="utf-8") == out
        print("index.html 이 src/ 와 일치합니다." if same else "index.html 이 src/ 와 다릅니다. python3 build.py 를 실행하세요.")
        sys.exit(0 if same else 1)
    target.write_text(out, encoding="utf-8")
    print(f"index.html 생성 ({len(out.encode('utf-8')):,} 바이트)")
