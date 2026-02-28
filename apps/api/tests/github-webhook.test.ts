import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { clearQueue, stopScanWorker } from '../src/scanner/queue.js';
import { clearStore } from '../src/scanner/store.js';

const ORIGINAL_WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'];
const ORIGINAL_APP_ID = process.env['GITHUB_APP_ID'];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** HMAC-SHA256 시그니처 생성 헬퍼 */
function generateSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** 테스트용 push 이벤트 페이로드 */
const PUSH_BODY = {
  ref: 'refs/heads/main',
  repository: {
    clone_url: 'https://github.com/test/repo.git',
    full_name: 'test/repo',
  },
  pusher: {
    name: 'testuser',
  },
};

/** 테스트용 pull_request opened 이벤트 페이로드 */
const PR_BODY_OPENED = {
  action: 'opened',
  pull_request: {
    number: 1,
    head: {
      ref: 'feature/test-branch',
      sha: 'abc123def456',
    },
    base: {
      ref: 'main',
    },
    html_url: 'https://github.com/test/repo/pull/1',
  },
  repository: {
    clone_url: 'https://github.com/test/repo.git',
    full_name: 'test/repo',
  },
};

describe('GitHub Webhook API', () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    stopScanWorker();
    clearQueue();
    clearStore();
    delete process.env['GITHUB_WEBHOOK_SECRET'];
    delete process.env['GITHUB_APP_ID'];
  });

  afterEach(() => {
    restoreEnv('GITHUB_WEBHOOK_SECRET', ORIGINAL_WEBHOOK_SECRET);
    restoreEnv('GITHUB_APP_ID', ORIGINAL_APP_ID);
  });

  describe('Webhook 시그니처 검증', () => {
    it('올바른 HMAC-SHA256 시그니처이면 정상 처리(202)해야 한다', async () => {
      process.env['GITHUB_WEBHOOK_SECRET'] = 'test-secret';
      const bodyStr = JSON.stringify(PUSH_BODY);
      const sig = generateSignature('test-secret', bodyStr);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': sig,
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json().received).toBe(true);
    });

    it('잘못된 시그니처이면 401 Unauthorized를 반환해야 한다', async () => {
      process.env['GITHUB_WEBHOOK_SECRET'] = 'test-secret';
      const bodyStr = JSON.stringify(PUSH_BODY);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=invalidsignaturehex',
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    it('GITHUB_WEBHOOK_SECRET 미설정 시 시그니처 검증을 스킵하고 정상 처리해야 한다', async () => {
      // GITHUB_WEBHOOK_SECRET 미설정 (beforeEach에서 이미 삭제됨)
      const bodyStr = JSON.stringify(PUSH_BODY);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          // 시그니처 헤더 없음
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(202);
    });
  });

  describe('Push 이벤트 처리', () => {
    it('refs/heads/main push 이벤트 시 3개 엔진 스캔을 생성하고 202를 반환해야 한다', async () => {
      const bodyStr = JSON.stringify(PUSH_BODY);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json().scansTriggered).toBe(3);
    });

    it('응답에 scansTriggered 수가 포함되어야 한다', async () => {
      const bodyStr = JSON.stringify(PUSH_BODY);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
        },
        payload: bodyStr,
      });

      expect(response.json()).toHaveProperty('scansTriggered');
      expect(typeof response.json().scansTriggered).toBe('number');
    });

    it('생성된 스캔의 repoUrl, branch, engine이 올바르게 설정되어야 한다', async () => {
      const bodyStr = JSON.stringify(PUSH_BODY);

      await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
        },
        payload: bodyStr,
      });

      const scansRes = await app.inject({ method: 'GET', url: '/api/v1/scans' });
      const scans = scansRes.json() as Array<{ repoUrl: string; branch: string; engine: string }>;

      expect(scans).toHaveLength(3);

      for (const scan of scans) {
        expect(scan.repoUrl).toBe('https://github.com/test/repo.git');
        expect(scan.branch).toBe('main');
      }

      const engines = scans.map((s) => s.engine).sort();
      expect(engines).toEqual(['gitleaks', 'semgrep', 'trivy']);
    });
  });

  describe('Pull Request 이벤트 처리', () => {
    it('PR opened 이벤트 시 3개 엔진 스캔을 생성하고 202를 반환해야 한다', async () => {
      const bodyStr = JSON.stringify(PR_BODY_OPENED);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json().scansTriggered).toBe(3);
    });

    it('PR synchronize 이벤트 시 3개 엔진 스캔을 생성해야 한다', async () => {
      const prSyncBody = { ...PR_BODY_OPENED, action: 'synchronize' };
      const bodyStr = JSON.stringify(prSyncBody);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json().scansTriggered).toBe(3);
    });

    it('PR closed 이벤트는 200 + ignored 응답을 반환해야 한다', async () => {
      const prClosedBody = { ...PR_BODY_OPENED, action: 'closed' };
      const bodyStr = JSON.stringify(prClosedBody);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().action).toBe('ignored');
    });
  });

  describe('지원하지 않는 이벤트', () => {
    it('x-github-event: "issues" 이벤트는 200 + ignored를 반환해야 한다', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
        },
        payload: JSON.stringify({ action: 'opened' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().action).toBe('ignored');
    });

    it('x-github-event 헤더가 없으면 400을 반환해야 한다', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          // x-github-event 헤더 없음
        },
        payload: JSON.stringify(PUSH_BODY),
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('잘못된 요청', () => {
    it('빈 body는 400을 반환해야 한다', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
        },
        payload: '',
      });

      expect(response.statusCode).toBe(400);
    });

    it('repository 필드가 없으면 400을 반환해야 한다', async () => {
      const bodyWithoutRepo = {
        ref: 'refs/heads/main',
        pusher: { name: 'testuser' },
        // repository 필드 없음
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
        },
        payload: JSON.stringify(bodyWithoutRepo),
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GitHub 연동 상태 엔드포인트', () => {
    it('GET /api/v1/github/status는 200과 연동 상태를 반환해야 한다', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/github/status',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('webhookConfigured');
      expect(response.json()).toHaveProperty('appIdConfigured');
      expect(response.json()).toHaveProperty('mockMode');
    });

    it('GITHUB_WEBHOOK_SECRET 미설정 시 webhookConfigured가 false여야 한다', async () => {
      // beforeEach에서 이미 환경변수 삭제됨

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/github/status',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().webhookConfigured).toBe(false);
      expect(response.json().mockMode).toBe(true);
    });

    it('GITHUB_WEBHOOK_SECRET 설정 시 webhookConfigured가 true여야 한다', async () => {
      process.env['GITHUB_WEBHOOK_SECRET'] = 'test-secret';

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/github/status',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().webhookConfigured).toBe(true);
    });
  });
});
