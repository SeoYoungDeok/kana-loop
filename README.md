# Kana Loop

히라가나와 가타카나 208문항을 한글 또는 로마자로 연습하는 PC 브라우저 앱입니다.

## 실행

Node.js 22.18 이상에서 실행합니다.

```sh
npm ci
npm run dev
```

Enter로 답을 제출하거나 오답을 확인한 뒤 다음 문제로 이동합니다. Esc로 문제를 건너뛰고 Ctrl+Z(macOS는 ⌘Z도 가능)로 직전 채점을 취소합니다.

## 검증

```sh
npm test
npx playwright install chromium
npm run test:browser
```

설치된 Chrome으로 검증하려면 `KANA_CHROME_CHANNEL=chrome npm run test:browser`를 실행합니다.

## 빌드와 배포

[Kana Loop 열기](https://seoyoungdeok.github.io/kana-loop/)

`main`에 `git push`하면 GitHub Actions가 테스트와 빌드를 실행한 뒤 `dist/`를 자동 배포합니다. 진행 상태는 저장소의 [Actions 탭](https://github.com/SeoYoungDeok/kana-loop/actions)에서 확인할 수 있습니다.

```sh
npm run build
npm run preview
```

오프라인 기능은 프로덕션 빌드를 HTTPS 또는 localhost에서 열고 캐시가 준비된 뒤 사용할 수 있습니다.

진도는 현재 사이트 주소의 브라우저 프로필에 저장됩니다. 사이트 주소나 브라우저를 바꿀 때는 설정의 JSON 내보내기와 가져오기를 사용합니다.

문항 정책, 출제 공식, 저장 데이터 구조는 [v1.0 명세](./kana-loop-spec-v1.0.md)에 있습니다.
