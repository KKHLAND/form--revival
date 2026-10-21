# 작업 규칙

- `index.html` 은 빌드 결과물입니다. 고칠 때는 `src/` 의 파일을 수정한 뒤 `python3 build.py` 로 다시 만들고, 둘을 함께 커밋합니다.
- 커밋 전 `python3 build.py --check` 가 통과해야 합니다.
- 화면 문구는 한국어로, 교사가 바로 알아듣는 말로 씁니다.
- `src/engine.js` 는 브라우저와 Node 양쪽에서 돌아가야 합니다(`module.exports` / `window.FormEngine`). 엔진을 바꾸면 Node에서 `pdfjs-dist@3.11.174`·`jszip@3.10.1` 로 실제 PDF를 변환해 보고, 결과 hwpx의 `Contents/header.xml`·`section0.xml` 이 XML로 읽히는지 확인합니다. Node에서 `require('./src/engine.js')` 하면 옆의 `font-metrics.json` 을 자동으로 읽습니다.
- hwpx 생성 규칙: mimetype은 zip 첫 항목·무압축, 문단에 `linesegarray` 를 넣지 않음, 표 id·zOrder는 고유값, 서식 ID는 header.xml 에 추가한 것만 참조.
