# DDL 브랜드커머스 관리

브랜드를 고르면 그 브랜드의 **채널별 매출 목표·실적 / 운영 캘린더 / 업무 / 제품**이 한 화면에 뜹니다.
깃허브 페이지(정적) + 노션(데이터 보관) 구조라 서버가 따로 필요 없습니다. EK OEM 통합관리와 같은 방식입니다.

```
브라우저(깃허브 페이지)  ──POST──►  Cloudflare Worker  ──►  Notion API
        ▲                              (토큰 보관)
        └── 평소엔 브라우저 로컬 저장으로 즉시 동작
```

---

## 1. 깃허브에 올리기

새 저장소(예: `ddl-brand`)를 만들고 `index.html`을 루트에 올립니다.

```bash
git init && git add index.html README.md
git commit -m "브랜드커머스 관리페이지"
git branch -M main
git remote add origin https://github.com/deun01-cloud/ddl-brand.git
git push -u origin main
```

Settings → Pages → Source `Deploy from a branch` → `main` / `(root)` → Save.
1분 뒤 `https://deun01-cloud.github.io/ddl-brand/` 로 열립니다.

> ek-oem 저장소 안에 넣고 싶으면 `ek-oem/brand/index.html`로 올리면 `.../ek-oem/brand/`에서 열리고,
> ek-oem 상단 메뉴의 **🛍 브랜드커머스**에서 이 주소로 링크만 걸면 됩니다.

## 2. Worker 올리기 (노션 연동을 쓸 때만)

1. Cloudflare → Workers & Pages → Create Worker → `worker.js` 내용 붙여넣기 → Deploy
2. Settings → Variables → **Secret** `NOTION_TOKEN` = 노션 인테그레이션 토큰
3. (선택) `ALLOW_ORIGIN` = `https://deun01-cloud.github.io`
4. 배포 주소를 관리페이지 **설정 · 동기화 → Worker URL**에 붙여넣고 저장

토큰은 Worker에만 있고 브라우저에는 남지 않습니다. ek-oem에 이미 쓰는 Worker가 있어도, 이 앱은 요청 형식이 다르니 **따로 하나 더** 올리는 편이 안전합니다.

## 3. 노션 DB — 이미 만들어 뒀습니다

`프로젝트 DDL > 🛍 브랜드커머스 관리` 아래에 DB 4개를 생성했고, ID는 `index.html`에 미리 넣어 뒀습니다.
브랜드 선택지(VIVICATE·ARIKIV·AUBE SEOUL·RUHEL·USUEL·FLUD K·OOTN)와 유형·영역·담당자 옵션도 채워져 있습니다.

| DB | ID | 뷰 |
|---|---|---|
| 콘텐츠 캘린더 | `22c3381ad8e44f239be74fdd3243eba3` | 월 캘린더 |
| 업무 | `047f49d200d74848b78adbb90f93906a` | 영역별 보드 (To do만) |
| 매출 | `5ca27a6560214303bc77b2da9e48ce02` | 표 |
| 제품 | `ddd18f71b6c9475abc59f74881cff410` | 파이프라인 보드 |

매출 DB에는 VIVICATE 8·9월 온라인 목표(자사몰 800·1,000 / ZVZO 200·200 / 29CM 900·1,200만원)를 넣어 뒀습니다.

**남은 것 하나** — Worker를 만든 뒤 노션 인테그레이션을 위 DB 4개에 각각 연결(⋯ → 연결)해야 API가 읽고 씁니다.
`로컬ID` 속성은 관리페이지와 노션을 짝지어 주는 값이라 지우지 마세요.

---

## 쓰는 법

- **요약** — 채널 막대에 세로선이 하나 그어져 있습니다. 오늘까지 지나간 달의 비율(진도선)이라, 막대가 이 선보다 짧으면 페이스가 밀린 겁니다. 밀린 채널은 색이 흐려집니다.
- **콘텐츠 캘린더** — 날짜 칸의 `+`로 항목을 넣습니다. 8개 유형 중 이달 한 건도 없는 유형은 요약 화면에 빨간 점선으로 표시됩니다.
- **업무** — 영역별로 `7일 이내 / 이후` 두 열, 마감 임박순 정렬, D-DAY 표기. 지난 건 D+로 바뀝니다.
- **매출** — 목표·실적을 칸에 바로 입력하면 저장됩니다. 채널 구성은 브랜드별로 다르게 둘 수 있습니다.
- **모든 브랜드 비교** — 7개 브랜드를 같은 진도선 기준으로 한 화면에서 봅니다.

데이터는 입력 즉시 브라우저에 저장되고, 노션 반영은 **설정 → 노션으로 올리기**를 누를 때 합니다.
다른 기기에서 이어서 볼 땐 **노션에서 내려받기**를 먼저 누르세요.

## 손볼 자리

- 브랜드·채널 구성: 설정 화면에서 바로 수정 (코드 수정 불필요)
- 콘텐츠 유형, 업무 영역, 담당자, 제품 상태: `index.html` 위쪽 `TYPES` / `AREAS` / `OWNERS` / `PSTATUS` 상수
- 색: `:root` 변수와 브랜드별 `hue` 값(0–360)
