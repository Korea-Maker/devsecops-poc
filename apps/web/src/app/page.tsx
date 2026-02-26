const LOCKED_DECISIONS = [
  "Q1: SAST + SCA + Secret 탐지",
  "Q2: 우선 가치 = 가격 + 간편함",
  "Q3: MVP = 스캔 + 대시보드 + CI 연동",
  "Q4: Backend = TypeScript + Fastify (성능 이슈 시 Go 워커 분리 검토)",
  "Q5: Frontend = Next.js (App Router)",
  "Q6: DB = PostgreSQL",
  "Q7: CI 통합 = GitHub App",
  "Q8: 언어 우선 지원 = JS/TS + Python",
  "Q9: 타겟 팀 = 초기 1~5명",
  "Q10: 인증 = Google SSO",
] as const;

export default function HomePage() {
  return (
    <main style={{ maxWidth: 840, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 32, marginBottom: 12 }}>DevSecOps PoC (Phase 1)</h1>

      <p style={{ marginBottom: 20, lineHeight: 1.7 }}>
        스타트업 개발팀이 <strong>저비용 + 간편한 방식</strong>으로 보안 스캔을 CI에
        연결할 수 있게 만드는 PoC입니다. 현재 스프린트는 부트스트랩 단계이며,
        백엔드/프론트엔드/로컬 DB 기본 골격을 고정했습니다.
      </p>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, marginBottom: 10 }}>확정 의사결정</h2>
        <ul style={{ paddingLeft: 20, lineHeight: 1.9 }}>
          {LOCKED_DECISIONS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, marginBottom: 10 }}>API 노트</h2>
        <ul style={{ paddingLeft: 20, lineHeight: 1.8 }}>
          <li>
            <code>GET /health</code> → <code>{'{ ok: true, service: "api" }'}</code>
          </li>
          <li>
            <code>POST /api/v1/scans</code> → <code>501 Not Implemented</code>
          </li>
        </ul>
      </section>

      <section>
        <h2 style={{ fontSize: 20, marginBottom: 10 }}>다음 단계</h2>
        <ol style={{ paddingLeft: 20, lineHeight: 1.8 }}>
          <li>SAST/SCA/Secret 엔진 어댑터 인터페이스 설계</li>
          <li>스캔 요청/결과 저장용 Prisma 스키마 정의</li>
          <li>GitHub App 이벤트 수신 기본 구조 구현</li>
        </ol>
      </section>
    </main>
  );
}
