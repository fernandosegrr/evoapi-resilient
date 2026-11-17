import { EventDto } from '@api/integrations/event/event.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { wa } from '@api/types/wa.types';
import { configService, Log, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
// import { BadRequestException } from '@exceptions';
import axios, { AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import * as jwt from 'jsonwebtoken';

import { EmitData, EventController, EventControllerInterface, WebhookDeliveryOptions } from '../event.controller';

export class WebhookController extends EventController implements EventControllerInterface {
  private readonly logger = new Logger('WebhookController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, true, 'webhook');
  }

  protected override get globalModeEnabled(): boolean {
    return !!configService.get<Webhook>('WEBHOOK').GLOBAL?.ENABLED;
  }

  override async set(instanceName: string, data: EventDto): Promise<wa.LocalWebHook> {
    // if (!/^(https?:\/\/)/.test(data.webhook.url)) {
    //   throw new BadRequestException('Invalid "url" property');
    // }

    // Saving a webhook as disabled only stops deliveries: it must not discard the selected events, otherwise turning it
    // on later (or re-saving the form) silently loses MESSAGES_UPSERT. An enabled webhook without events means "all".
    data.webhook.events ??= [];
    if (data.webhook.enabled && 0 === data.webhook.events.length) {
      data.webhook.events = EventController.events;
    }

    return this.prisma.webhook.upsert({
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
      create: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
    });
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    local,
    integration,
    extra,
    webhookDelivery,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('webhook')) {
      return;
    }

    const instance = webhookDelivery?.webhookSnapshot ?? ((await this.get(instanceName)) as wa.LocalWebHook);

    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const webhookLocal = instance?.events;
    const webhookHeaders = { ...((instance?.headers as Record<string, string>) || {}) };
    const idempotencyKey = this.createIdempotencyKey(instanceName, event, data, dateTime);
    webhookHeaders['Idempotency-Key'] = idempotencyKey;
    const deliveryErrors: unknown[] = [];

    if (webhookHeaders && 'jwt_key' in webhookHeaders) {
      const jwtKey = webhookHeaders['jwt_key'];
      const jwtToken = this.generateJwtToken(jwtKey);
      webhookHeaders['Authorization'] = `Bearer ${jwtToken}`;

      delete webhookHeaders['jwt_key'];
    }

    const we = EventController.eventKey(event);
    const transformedWe = event.replace(/[._]/gm, '-').toLowerCase();
    const enabledLog = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');
    const regex = /^(https?:\/\/)/;

    const webhookData = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      destination: instance?.url || `${webhookConfig.GLOBAL.URL}/${transformedWe}`,
      date_time: dateTime,
      sender,
      server_url: serverUrl,
      apikey: apiKey,
    };

    if (local && instance?.enabled) {
      if (Array.isArray(webhookLocal) && webhookLocal.includes(we)) {
        let baseURL: string;

        if (instance?.webhookByEvents) {
          baseURL = `${instance?.url}/${transformedWe}`;
        } else {
          baseURL = instance?.url;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook`,
            url: baseURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (!regex.test(instance.url)) throw new Error(`Invalid local webhook URL: ${instance.url ?? ''}`);

          const httpService = axios.create({
            baseURL,
            headers: webhookHeaders as Record<string, string> | undefined,
            timeout: webhookDelivery?.timeoutMs ?? webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
          });

          await this.retryWebhookRequest(
            httpService,
            webhookData,
            `${origin}.sendData-Webhook`,
            baseURL,
            serverUrl,
            webhookDelivery,
          );
        } catch (error) {
          deliveryErrors.push(error);
          this.logger.error({
            local: `${origin}.sendData-Webhook`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            deliveryStatus: 'failed_permanently',
            idempotencyKey,
            attempts: error?.webhookAttempts ?? 0,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: baseURL,
            server_url: serverUrl,
          });
        }
      }
    }

    if (webhookConfig.GLOBAL?.ENABLED) {
      if (webhookConfig.EVENTS[we]) {
        let globalURL = webhookConfig.GLOBAL.URL;

        if (webhookConfig.GLOBAL.WEBHOOK_BY_EVENTS) {
          globalURL = `${globalURL}/${transformedWe}`;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook-Global`,
            url: globalURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (!regex.test(globalURL)) throw new Error(`Invalid global webhook URL: ${globalURL ?? ''}`);

          const httpService = axios.create({
            baseURL: globalURL,
            headers: { 'Idempotency-Key': idempotencyKey },
            timeout: webhookDelivery?.timeoutMs ?? webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
          });

          await this.retryWebhookRequest(
            httpService,
            webhookData,
            `${origin}.sendData-Webhook-Global`,
            globalURL,
            serverUrl,
            webhookDelivery,
          );
        } catch (error) {
          deliveryErrors.push(error);
          this.logger.error({
            local: `${origin}.sendData-Webhook-Global`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            deliveryStatus: 'failed_permanently',
            idempotencyKey,
            attempts: error?.webhookAttempts ?? 0,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: globalURL,
            server_url: serverUrl,
          });
        }
      }
    }

    if (deliveryErrors.length > 0 && webhookDelivery?.throwOnFailure) {
      const error = new Error(
        `Webhook event "${event}" (${idempotencyKey}) failed for ${deliveryErrors.length} destination(s)`,
      );
      (error as any).causes = deliveryErrors;
      throw error;
    }
  }

  private async retryWebhookRequest(
    httpService: AxiosInstance,
    webhookData: any,
    origin: string,
    baseURL: string,
    serverUrl: string,
    deliveryOptions?: WebhookDeliveryOptions,
  ): Promise<void> {
    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const maxRetryAttempts = Math.max(1, deliveryOptions?.maxAttempts ?? webhookConfig.RETRY?.MAX_ATTEMPTS ?? 10);
    const initialDelay = deliveryOptions?.initialDelaySeconds ?? webhookConfig.RETRY?.INITIAL_DELAY_SECONDS ?? 5;
    const useExponentialBackoff = webhookConfig.RETRY?.USE_EXPONENTIAL_BACKOFF ?? true;
    const maxDelay = deliveryOptions?.maxDelaySeconds ?? webhookConfig.RETRY?.MAX_DELAY_SECONDS ?? 300;
    const jitterFactor = webhookConfig.RETRY?.JITTER_FACTOR ?? 0.2;
    const nonRetryableStatusCodes = webhookConfig.RETRY?.NON_RETRYABLE_STATUS_CODES ?? [400, 401, 403, 404, 422];

    let attempts = 0;

    while (attempts < maxRetryAttempts) {
      try {
        await httpService.post('', webhookData);
        if (attempts > 0) {
          this.logger.log({
            local: `${origin}`,
            message: `Sucesso no envio após ${attempts + 1} tentativas`,
            url: baseURL,
          });
        }
        return;
      } catch (error) {
        attempts++;

        const isTimeout = error.code === 'ECONNABORTED';

        if (error?.response?.status && nonRetryableStatusCodes.includes(error.response.status)) {
          error.webhookAttempts = attempts;
          this.logger.error({
            local: `${origin}`,
            message: `Erro não recuperável (${error.response.status}): ${error?.message}. Cancelando retentativas.`,
            statusCode: error?.response?.status,
            url: baseURL,
            server_url: serverUrl,
          });
          throw error;
        }

        this.logger.error({
          local: `${origin}`,
          message: `Tentativa ${attempts}/${maxRetryAttempts} falhou: ${isTimeout ? 'Timeout da requisição' : error?.message}`,
          hostName: error?.hostname,
          syscall: error?.syscall,
          code: error?.code,
          isTimeout,
          statusCode: error?.response?.status,
          error: error?.errno,
          stack: error?.stack,
          name: error?.name,
          url: baseURL,
          server_url: serverUrl,
        });

        if (attempts === maxRetryAttempts) {
          error.webhookAttempts = attempts;
          throw error;
        }

        let nextDelay = initialDelay;
        if (useExponentialBackoff) {
          nextDelay = Math.min(initialDelay * Math.pow(2, attempts - 1), maxDelay);

          const jitter = nextDelay * jitterFactor * (Math.random() * 2 - 1);
          nextDelay = Math.max(initialDelay, nextDelay + jitter);
        }

        this.logger.log({
          local: `${origin}`,
          message: `Aguardando ${nextDelay.toFixed(1)} segundos antes da próxima tentativa`,
          url: baseURL,
        });

        await new Promise((resolve) => setTimeout(resolve, nextDelay * 1000));
      }
    }
  }

  private createIdempotencyKey(instanceName: string, event: string, data: any, dateTime: string): string {
    const items = Array.isArray(data) ? data : [data];
    const messageIdentities = items
      .map((item) => item?.key ?? item?.message?.key)
      .filter((key) => key?.id)
      .map((key) => key.id);
    const eventIdentity = messageIdentities.length > 0 ? messageIdentities.sort().join(',') : dateTime;
    const digest = createHash('sha256').update(`${instanceName}:${event}:${eventIdentity}`).digest('hex');

    return `evolution-${digest}`;
  }

  private generateJwtToken(authToken: string): string {
    try {
      const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600, // 10 min expiration
        app: 'evolution',
        action: 'webhook',
      };

      const token = jwt.sign(payload, authToken, { algorithm: 'HS256' });
      return token;
    } catch (error) {
      this.logger.error({
        local: 'WebhookController.generateJwtToken',
        message: `JWT generation failed: ${error?.message}`,
      });
      throw error;
    }
  }
}
