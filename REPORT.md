# 조선 야행 — 산속 미로 탈출 (컴퓨터그래픽스 기말 프로젝트)

> Three.js 기반 1인칭 공포 미로 게임. 핵심 그래픽스 기술로 **DDGI(Dynamic Diffuse Global Illumination)** 를 직접 구현한다.
>
> **플레이 링크:** https://jonghunpark09093.github.io/joseon-maze/ · **소스:** https://github.com/jonghunpark09093/joseon-maze

> 본 리포트의 모든 그림은 **이 게임에서 직접 캡쳐한 이미지**(`captures/`)다. 외부/예시 이미지는 사용하지 않았다.

---

## 1. 게임 개요 (기획)

- **컨셉:** 칠흑 같은 조선 산속, 등불 하나에 의지해 미로를 빠져나가는 공포 탈출 게임.
- **조작:** `WASD` 이동 · 마우스 시점 · `Shift` 달리기.
- **목표:** 출구 셀에 도달하면 탈출 성공. 어둠 속 추격자에게 붙잡히면 실패.
- **왜 미로 + 등불인가 (GI 관점):** 어두운 실내 + 강한 색의 벽(단청 적색) + 이동하는 광원(등불) 조합은 **간접광·색 번짐(color bleeding)** 이 가장 잘 드러나는 무대다. DDGI의 효과를 시각적으로 증명하기에 최적.

**미로 전체 구조 (top-down, 디버그용 평면 조명):** 25×25 점유 격자가 단청 적색 벽(인스턴싱)으로 월드에 배치된 모습.

![미로 평면도](captures/maze_topdown.png)

---

## 2. 강의 내용 ↔ 구현 매핑

> 강의에서 다룬 그래픽스 파이프라인(좌표 변환 → 셰이딩/라이팅 → 텍스처 → 글로벌 일루미네이션 → 애니메이션) 순서로 매핑한다.

### 2.1 좌표 변환 파이프라인 (Model → World → View → Projection)
- 미로 벽은 로컬 박스 지오메트리(Model space)를 `InstancedMesh`의 인스턴스 행렬로 World space에 배치 → 강의의 **SRT/Model 변환** 대응.
- 1인칭 카메라가 View 변환을, `PerspectiveCamera`가 Projection 변환을 담당.
- 위 §1 평면도가 인스턴싱된 월드 배치 결과다.

### 2.2 셰이딩 & 라이팅 (Phong / Blinn-Phong, 광원 타입)
- `MeshStandardMaterial`(물리 기반) + 점광원(등불, `PointLight`)으로 **확산광/반사광/거리 감쇠** 표현 → 폼 반사 모델·Attenuation 대응.
- 광원 타입: 등불=Point Light, 달빛=Directional Light, 배경 채움광=Ambient Light → Light Source Types 대응.
- 아래 인게임 화면에서 등불을 중심으로 한 거리 감쇠(가까운 벽은 밝고 멀수록 어두워짐)를 볼 수 있다.

![인게임 1인칭 — 등불 거리 감쇠](captures/ddgi_on.png)

### 2.3 텍스처 (향후 작업)
- 현재는 단색 머티리얼(단청 적색/흙색). 벽·바닥 단청·흙 텍스처 + UV 매핑은 아트 패스에서 추가 예정.

### 2.4 글로벌 일루미네이션 — DDGI (핵심)
- 프로브 격자 + 옥타헤드럴 irradiance/depth atlas + **SDF 레이마칭** + **Chebyshev 가시성** 으로 DDGI를 직접 구현. 상세는 §4.

**GI OFF vs ON (간접광·색 번짐):** 등불의 따뜻한 빛이 단청 적색 벽에 반사되어 직접광이 닿지 않는 영역까지 붉게 물든다.

| GI OFF | GI ON |
|---|---|
| ![GI off](captures/ddgi_off.png) | ![GI on](captures/ddgi_on.png) |

**Dynamic — 등불 이동 시 실시간 갱신:** 플레이어(=등불)가 새 구역으로 이동하면 그 구역의 프로브가 즉시 재수렴한다. (이동 직후 / 수렴 후)

| 이동 직후 | 수렴 후 |
|---|---|
| ![dynamic early](captures/dyn_early.png) | ![dynamic late](captures/dyn_late.png) |

### 2.5 애니메이션 — 추격자 & 등불 흔들림
- 추격자(귀신)가 점유 격자 위 **BFS 경로 탐색** 으로 플레이어를 실시간 추적(애니메이션/이동). 등불은 사인 합으로 흔들림(flicker).
- 어둠 속에서는 추격자의 **빨간 눈** 만 보인다(공포 연출 + 광원/이미시브 대비).

![추격자 — 복도 끝의 빨간 눈](captures/pursuer_lit.png)

---

## 3. 개발 상세

### 3.1 미로 생성 — 재귀 백트래커 + 점유 격자
- `cellsX × cellsZ` 셀 격자에 재귀 백트래커로 완전 미로를 생성하고, `(2W+1)×(2H+1)` **점유 격자(1=벽, 0=바닥)** 로 확장.
- 이 점유 격자는 **충돌·렌더링·DDGI의 SDF가 공유하는 단일 진실 공급원(single source of truth)**. (§1 평면도 참조)

### 3.2 충돌 처리
- 플레이어를 원(disc)으로 보고 점유 격자의 벽 셀 AABB와 교차 검사. X·Z축 분리 이동으로 벽을 따라 미끄러짐.

### 3.3 등불 (이동 광원)
- 카메라를 따라다니는 따뜻한 점광원 + flicker. 그림자 맵 포함.

### 3.4 추격자 (게임플레이)
- `src/pursuer.js`. 0.5초마다 점유 격자 BFS로 플레이어 셀까지 경로 재탐색, 보행 속도보다 느리게(2.7) 추적 → 길을 아는 플레이어는 탈출 가능한 긴장감.
- `catchRadius` 진입 시 게임오버 오버레이 + 클릭 재시작. 근접 시 HUD 경고.

---

## 4. DDGI 구현 상세

> "irradiance probe"를 진짜 **DDGI** 로 만드는 핵심은 **프로브별 가시성(visibility)** 이다. 본 구현은 SDF 레이마칭 gather + Chebyshev 깊이 모멘트로 이를 직접 구현한다. (`src/ddgi.js`)

### 4.1 프로브 그리드 배치
- 점유 격자 해상도에 맞춘 3D 프로브 격자(`gw × 3 × gh`). 각 프로브는 옥타헤드럴 타일로 irradiance와 depth-moment를 저장.

### 4.2 SDF 레이마칭으로 프로브 광선 추적 (하드웨어 RT 없이 WebGL2)
- 미로는 축 정렬 격자이므로 점유 격자를 **SDF** 로 보고 프래그먼트 셰이더에서 DDA 레이마칭. 하드웨어 레이트레이싱 없이 프로브마다 다방향 광선을 추적해 등불 직접광 + 벽 반사 albedo를 적분.

### 4.3 옥타헤드럴 irradiance/depth atlas (MRT)
- 한 번의 gather 패스에서 **MRT 2채널** 로 (1) irradiance와 (2) 거리·거리² 모멘트를 동시에 출력. 코사인 가중 누적 + 시간적(temporal) 블렌딩으로 노이즈 억제.

### 4.4 Chebyshev 가시성 테스트 (빛 샘 방지) — irradiance probe와 DDGI를 가르는 지점
- 셰이딩 점이 프로브의 평균 거리보다 멀면 "벽 뒤"로 보고 variance shadow(체비셰프 부등식)로 기여를 차감 → 벽 너머 누수 차단.
- **설계 노트(정직한 관찰):** 본 구현은 gather 단계에서 이미 SDF 가시성을 계산하므로 누수가 본질적으로 적다. 따라서 Chebyshev는 주로 **트라이리니어 보간 단계의 잔여 누수**를 잡는 보정 역할이다.

| Chebyshev OFF | Chebyshev ON |
|---|---|
| ![cheby off](captures/cheby_off.png) | ![cheby on](captures/cheby_on.png) |

- **자기-차폐(self-occlusion) 보정:** Chebyshev를 그대로 켜면 벽이 자기 자신을 가려 벽면에 어두운 얼룩이 생긴다. 가시성 비교 전에 셰이딩 점을 노멀 방향으로 밀어내는 **노멀 바이어스(`uNormalBias`)** 로 해결했다.

### 4.5 동적 갱신
- 등불 위치를 매 프레임 gather 셰이더에 전달하고, 핑퐁 타깃으로 프로브를 지속 갱신 → 광원이 움직이면 간접광도 실시간으로 따라온다. (§2.4 Dynamic 그림)

### 4.6 한계 및 관찰 (정직한 분석)

> 프로브 기반 GI는 본질적으로 **프로브 격자 해상도와 보간**에 묶인 근사다. 본 구현에서도 다음 두 아티팩트가 관찰됐고, 이는 DDGI 계열의 알려진 trade-off다.

![DDGI 한계 — Y축 banding과 프로브 보간 셀](captures/ddgi_banding.png)

- **세로(Y축) banding:** 프로브 격자가 `gw × 3 × gh`로 **수직 방향이 3층뿐**이다. 셰이딩 점이 위/아래 프로브 사이를 트라이리니어 보간할 때 특정 높이에서 가중치가 급변해, 벽면에 가로 띠처럼 밝기가 바뀌는 구간이 생긴다.
- **프로브 보간 셀 가시성:** 보간 셀 하나가 월드에서 크다 보니(셀 ≈ 4단위) 가까이서 보면 프로브 단위의 둥근 falloff가 눈에 드러난다. 위 그림 정면 벽의 타원형 밝은 영역이 그 흔적이다.
- **개선 방향(미적용):** 수직 프로브 층수↑ 또는 보간 셀 축소로 완화 가능하나, gather 패스 비용과 아틀라스 메모리가 증가한다. 실시간성과 마감을 고려해 현재 해상도를 유지하고 한계로 명시했다.

---

## 5. 실행 및 배포

```bash
npm install
npm run dev      # 로컬 개발 (http://localhost:5180)
npm run build    # 정적 빌드 → dist/
npm run preview  # 빌드 결과 미리보기
```

- **배포:** GitHub Pages — https://jonghunpark09093.github.io/joseon-maze/ (main 푸시 시 GitHub Actions가 자동 빌드·배포)
- `vite.config.js`의 `base: './'` 로 상대 경로 빌드 → 임의의 정적 호스트/서브경로에서 동작.
