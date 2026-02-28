import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { enqueueScan } from '../scanner/queue.js';
import { createScan } from '../scanner/store.js';
import {
  extractScanTrigger,
  parseWebhookEvent,
  verifySignature,
  type ScanTrigger,
} from '../integrations/github/webhook.js';

interface RouteErrorBody {
  error: string;
  code?: string;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  code?: string
): ReturnType<FastifyReply['status']> {
  const body: RouteErrorBody = { error };
  if (code) {
    body.code = code;
  }
  return reply.status(statusCode).send(body);
}

/**
 * GitHub 연동 라우트 플러그인.
 * - POST /api/v1/github/webhook : webhook 수신 + 스캔 트리거
 * - GET  /api/v1/github/status  : 연동 상태 확인
 */
export const githubRoutes: FastifyPluginAsync = async (app) => {
  // rawBody 접근을 위해 application/json을 직접 파싱하고 rawBody를 저장한다.
  // Fastify 기본 JSON 파서를 대체하여 원본 바이트를 보존한다.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (
      _req: FastifyRequest,
      body: Buffer,
      done: (err: Error | null, body?: unknown) => void
    ) => {
      try {
        const parsed = JSON.parse(body.toString('utf-8')) as unknown;
        // rawBody를 request 객체에 첨부 (시그니처 검증용)
        (_req as FastifyRequest & { rawBody: Buffer }).rawBody = body;
        done(null, parsed);
      } catch (err) {
        // statusCode를 붙여야 Fastify가 400으로 응답한다 (기본값은 500)
        const parseErr = err as Error & { statusCode?: number };
        parseErr.statusCode = 400;
        done(parseErr);
      }
    }
  );

  /** POST /api/v1/github/webhook — GitHub webhook 수신 + 스캔 트리거 */
  app.post('/api/v1/github/webhook', async (request, reply) => {
    const eventName = (request.headers['x-github-event'] as string | undefined) ?? '';
    const signatureHeader =
      (request.headers['x-hub-signature-256'] as string | undefined) ?? '';

    // 시그니처 검증 (GITHUB_WEBHOOK_SECRET 미설정 시 스킵 + 경고 로그)
    const webhookSecret = process.env['GITHUB_WEBHOOK_SECRET'];
    if (webhookSecret) {
      const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        return sendError(reply, 400, 'rawBody를 읽을 수 없습니다', 'WEBHOOK_RAW_BODY_MISSING');
      }

      const isValid = verifySignature(webhookSecret, rawBody, signatureHeader);
      if (!isValid) {
        return sendError(
          reply,
          401,
          'webhook 시그니처 검증에 실패했습니다',
          'WEBHOOK_SIGNATURE_INVALID'
        );
      }
    } else {
      app.log.warn(
        '[github-webhook] GITHUB_WEBHOOK_SECRET이 설정되지 않았습니다. 시그니처 검증을 건너뜁니다.'
      );
    }

    // x-github-event 헤더 필수 검증
    if (!eventName) {
      return sendError(reply, 400, 'x-github-event 헤더가 필요합니다', 'WEBHOOK_MISSING_EVENT_HEADER');
    }

    const event = parseWebhookEvent(eventName, request.body);

    // 지원하지 않는 이벤트
    if (event.type === 'unsupported') {
      return reply.status(200).send({ received: true, action: 'ignored' });
    }

    let trigger: ScanTrigger | null;
    try {
      trigger = extractScanTrigger(event);
    } catch {
      return sendError(reply, 400, '잘못된 webhook 페이로드입니다', 'WEBHOOK_INVALID_PAYLOAD');
    }

    // PR 이벤트 중 opened/synchronize 외의 action
    if (!trigger) {
      return reply.status(200).send({ received: true, action: 'ignored' });
    }

    // 각 엔진에 대해 스캔 생성 + 큐 등록
    let scansTriggered = 0;
    for (const engine of trigger.engines) {
      const scan = createScan({
        engine,
        repoUrl: trigger.repoUrl,
        branch: trigger.branch,
      });
      enqueueScan(scan.id);
      scansTriggered++;
    }

    app.log.info(
      `[github-webhook] ${event.type} 이벤트 수신 → ${scansTriggered}개 스캔 트리거 (repoUrl=${trigger.repoUrl}, branch=${trigger.branch})`
    );

    return reply.status(202).send({ received: true, scansTriggered });
  });

  /** GET /api/v1/github/status — GitHub 연동 상태 확인 */
  app.get('/api/v1/github/status', async (_request, reply) => {
    const webhookConfigured = Boolean(process.env['GITHUB_WEBHOOK_SECRET']);
    const appIdConfigured = Boolean(process.env['GITHUB_APP_ID']);

    return reply.status(200).send({
      webhookConfigured,
      appIdConfigured,
      mockMode: !appIdConfigured,
    });
  });
};
