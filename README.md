# 크로스페이드

스포티파이를 쓰는 친구와 애플뮤직을 쓰는 친구의 청취 기록을 한곳에서 비교하는 웹사이트입니다.
누가 무슨 곡을 몇 번 들었는지, 이번 주에 총 몇 분을 들었는지 볼 수 있습니다.

- 그룹 주간 합계와 서비스별 비중
- 친구 주간 랭킹 (지난주 같은 시점과 비교)
- 지금 듣는 중, 최근 재생
- 친구끼리 음악 취향 겹침 (최근 4주)
- 개인 상세 통계 (많이 들은 곡·아티스트, 요일별·시간대별)

## 실행

Node.js 22.13 이상이 필요하고, 설치할 패키지는 없습니다.

```bash
npm start
```

`http://localhost:3000` 을 열면 됩니다. API 키가 없으면 샘플 데이터로 실행됩니다.

## 실제 데이터 연결

1. https://www.last.fm/api/account/create 에서 API 키를 무료로 발급받습니다.
2. `.env.example` 을 `.env` 로 복사하고 `LASTFM_API_KEY` 와 `INVITE_CODE` 를 채웁니다.
3. 서버를 다시 시작합니다.

친구들은 초대 코드로 들어와 Last.fm 사용자 이름을 등록합니다.

- **Spotify 사용자:** Last.fm 설정에서 Spotify를 연결합니다.
- **Apple Music 사용자 (아이폰):** FastScrobbler 같은 스크로블 앱을 설치합니다.
- **Apple Music 사용자 (안드로이드):** Pano Scrobbler를 설치하고 알림 접근 권한을 허용합니다.
- **공통:** Last.fm 설정에서 "최근 청취 기록 숨기기"가 꺼져 있어야 합니다.

## Spotify 로그인 (선택)

Spotify 친구는 Last.fm 없이 Spotify 계정으로 바로 연결할 수도 있습니다.

1. [Spotify 대시보드](https://developer.spotify.com/dashboard)에서 앱을 만듭니다. 앱 주인은 Premium이어야 합니다.
2. Redirect URI에 `http://127.0.0.1:3000/api/spotify/callback` 을 등록합니다. `localhost` 는 허용되지 않습니다.
3. 앱 설정의 Users Management에 친구의 이름과 Spotify 이메일을 추가합니다.
4. Client ID를 `.env` 의 `SPOTIFY_CLIENT_ID` 에 넣고 서버를 다시 시작합니다. Client Secret은 필요 없습니다.

제한: 앱당 5명까지입니다. 연결하면 Spotify가 주는 최근 재생 50곡부터 쌓이기 시작하며, 그 이전 기록은 가져올 수 없습니다.
로그인 토큰은 `data/` 의 SQLite 파일에 저장되므로 이 폴더를 공유하면 안 됩니다.

## GitHub Pages로 배포

서버 없이 `.github/workflows/collect.yml` 이 15분쯤마다 기록을 모아 정적 사이트를 다시 올립니다.

- 공개 저장소에서 동작합니다. 청취 기록은 `site/data.enc` 에 초대 코드로, 누적 DB는 `data` 브랜치에 `DB_KEY` 로 암호화해 저장합니다.
- 저장소 Secrets에 `LASTFM_API_KEY`, `INVITE_CODE`, `DB_KEY` 를 넣고, Pages의 Source를 GitHub Actions로 설정합니다.
- 친구 추가와 삭제는 Actions 탭에서 `collect` 워크플로를 직접 실행해 입력합니다.
- Spotify 로그인은 서버가 필요해서 쓸 수 없습니다. Spotify 친구도 Last.fm으로 연결합니다.
- "지금 듣는 중"은 다음 수집 때까지 늦게 반영됩니다.
- GitHub 약관은 Actions를 서버리스 앱의 일부로 쓰지 말라고 안내합니다. 쓰기 전에 [약관](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)을 확인하세요.

## Last.fm을 쓰는 이유

- **Spotify API:** 개발 모드에서는 앱당 5명까지만 연결할 수 있습니다.
- **Apple Music API:** 재생 시각을 제공하지 않아 주간 청취 시간을 정확히 계산하기 어렵습니다.

Last.fm을 거치면 두 서비스의 재생 기록을 시각 정보와 함께 같은 형식으로 받을 수 있습니다.

## 알아둘 점

- 청취 시간은 재생한 곡의 전체 길이를 더한 추정치입니다. 곡을 끝까지 듣지 않아도 전체 길이로 계산됩니다.
- 길이를 알 수 없는 곡은 3분 30초로 계산하고, 그 비율을 화면에 표시합니다.
- 두 서비스의 표기가 크게 다르면 같은 곡으로 묶이지 않습니다. 예를 들어 `아이유` 와 `IU` 는 다른 아티스트로 계산됩니다.
- 스크로블 앱의 동작 방식에 따라 애플뮤직 기록이 늦게 올라올 수 있습니다. 최근 하루는 매번 다시 받아 보정합니다.
- 추가 후 처음에는 최근 8주치 기록을 가져옵니다.

## 구조

```
src/lastfm.js   Last.fm API 호출과 응답 파싱
src/sync.js     1분마다 청취 기록 수집, 곡 길이 채우기
src/stats.js    주간 통계, 취향 비교
src/server.js   HTTP 서버, 초대 코드 인증
src/collect.js  GitHub Actions용 수집과 암호화된 사이트 생성
src/crypto.js   저장 데이터 암호화
src/demo.js     데모용 샘플 데이터
public/         화면
```

데이터는 `data/` 폴더의 SQLite 파일에 저장됩니다. 배포할 때는 디스크가 유지되는 호스팅이 필요합니다.

## 테스트

```bash
npm test
```
