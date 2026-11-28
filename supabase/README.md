# Threads 수집기 적용 순서

분석 탭은 이미 배포된 `/api/threads-performance`로 `notion.threads_performance`를 읽습니다. 수집기는 그 테이블과 `hermes.threads_posts`, `hermes.threads_post_metrics`를 갱신합니다. 이 저장소에서는 SQL을 실행하지 않고, 시크릿을 넣지 않고, 함수를 배포하지 않습니다. 4번 크론은 이미 적용됨. 옛 크론 SQL 재실행 금지.

수집기에는 새 글 발행과 답글 자동화가 없습니다.

## 1. SQL — 테이블과 함수

Supabase SQL Editor에서 `supabase/migrations/20261128160000_threads_collector.sql` 을 실행합니다.

만드는 것:

- `hermes.threads_collector_runs` — 성공·실패 로그. 분석 화면의 **마지막 수집**이 이 로그의 마지막 성공 시각을 읽습니다. 로그가 없으면 글에 남은 마지막 관측 시각을 보여 줍니다.
- `hermes.threads_token_store` — 갱신된 60일 토큰. 서비스 롤만 읽습니다.
- `hermes.threads_account_snapshots` — 계정 팔로워 기준값. 글 성과에 합산하지 않습니다.
- `public.threads_collector_apply`, `threads_collector_log`, `threads_collector_save_token`

`anon`과 `authenticated`에는 권한을 주지 않습니다.

## 2. 시크릿

Edge Function 시크릿. 이름은 브랜드 설정의 `threads_token_env`와 같습니다.

| 이름 | 브랜드 |
|---|---|
| `THREADS_TOKEN_AUBE_SEOUL` | aube-seoul → 화면 브랜드 AUBE SEOUL / 오브서울 |
| `THREADS_TOKEN_MISSINGMAN` | missingman → 화면 브랜드 공장 / 미싱맨 (`공장(용저우)`) |
| `THREADS_TOKEN_ARIKIV` | arikiv. 기본은 꺼져 있습니다. 다시 돌릴 때만 값을 넣고 `lib/threads-collector.js`의 `enabled`를 바꿉니다. |

예전에 쓰던 환경변수 이름이 위와 다르면 코드의 `threadsTokenEnv`만 그 이름으로 고칩니다. 토큰 값 자체는 넣지 않습니다.

함수가 토큰을 갱신하면 새 값은 `hermes.threads_token_store`에 저장하고, 다음 실행부터 그 값을 먼저 읽습니다. 최초 1회만 위 시크릿을 읽습니다.

Vault 시크릿(`THREADS_COLLECTOR_URL`, `THREADS_COLLECTOR_SECRET`)은 4번 SQL이 직접 만듭니다. 서비스 롤 키를 Vault에 넣지 않습니다. 크론은 `THREADS_COLLECTOR_SECRET`으로 호출하고, 함수는 `public.threads_collector_auth()`로 확인합니다. 서비스 롤 키로 부르는 것도 그대로 됩니다.

## 3. Edge Function 배포

```bash
supabase functions deploy threads-collector --no-verify-jwt
```

`verify_jwt`는 꺼 둡니다. 서비스 롤 키가 JWT가 아닐 수 있어서, 함수가 `Authorization: Bearer`를 `SUPABASE_SERVICE_ROLE_KEY`와 직접 비교합니다. 크론이 Vault `THREADS_COLLECTOR_SECRET`으로 부르면 `public.threads_collector_auth()`로 확인합니다. 함수 배포와 시크릿 설정은 운영에 이미 반영되어 있습니다. 여기서 다시 배포하거나 시크릿을 넣지 않습니다.

프로젝트에 연결된 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`는 함수 런타임에 이미 있습니다.

## 4. SQL — 스케줄

이미 적용됨. 옛 크론 SQL 재실행 금지.

`supabase/migrations/20261128161000_threads_collector_cron.sql` 의 현재 내용(매일 07:30 KST `threads-archive`, 매일 05:00 KST `threads-token-refresh`, Vault `THREADS_COLLECTOR_SECRET`)은 운영 DB에 이미 들어가 있습니다. 이 파일을 다시 실행하지 마세요. 저장소에 있던 이전 버전(30분 `threads-metrics`, Vault의 `SUPABASE_SERVICE_ROLE_KEY`)도 다시 실행하지 마세요. 이전 버전을 실행하면 30분 잡이 돌아오고 크론이 서비스 롤 키를 읽습니다.

`pg_cron`과 `pg_net`이 필요합니다. 크론은 UTC입니다.

| 잡 | 크론 (UTC) | 한국 시간 | 하는 일 |
|---|---|---|---|
| `threads-archive` | `30 22 * * *` | 매일 07:30 | 최근 32일 글과 조회·반응을 한 번에 읽고 T+2 계정 참고값도 저장. 예전 `threads-archive` (07:30) |
| `threads-token-refresh` | `0 20 * * *` | 매일 05:00 | 만료 14일 전 60일 토큰 갱신. 예전 `token-watch` (05:00) |

30분 지표 수집은 두지 않습니다. 예전 hermes와 같이 하루 한 번(07:30)입니다. 필요하면 함수에 `metrics` job은 남아 있어 수동으로 부를 수 있습니다.

## 5. 화면 확인

관리자로 브랜드를 연 뒤 콘텐츠 → 분석.

- AUBE SEOUL에는 오브서울 글만, 공장에는 미싱맨(`공장(용저우)`) 글만 나옵니다.
- 마지막 수집이 하루보다 오래되면 그 사실을 화면 위에 적습니다.
- 수집이 성공하거나 실패하면 `hermes.threads_collector_runs`에 한 줄 남고, 성공 시각이 **마지막 수집**으로 바뀝니다.
