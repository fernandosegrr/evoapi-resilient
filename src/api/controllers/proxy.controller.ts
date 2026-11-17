import { InstanceDto } from '@api/dto/instance.dto';
import { ProxyDto } from '@api/dto/proxy.dto';
import { WAMonitoringService } from '@api/services/monitor.service';
import { ProxyService } from '@api/services/proxy.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { makeProxyAgent } from '@utils/makeProxyAgent';
import axios from 'axios';

const logger = new Logger('ProxyController');

export class ProxyController {
  constructor(
    private readonly proxyService: ProxyService,
    private readonly waMonitor: WAMonitoringService,
  ) {}

  public async createProxy(instance: InstanceDto, data: ProxyDto) {
    if (!this.waMonitor.waInstances[instance.instanceName]) {
      throw new NotFoundException(`The "${instance.instanceName}" instance does not exist`);
    }

    if (!data?.enabled) {
      data.host = '';
      data.port = '';
      data.protocol = '';
      data.username = '';
      data.password = '';
    }

    if (data.host) {
      const testProxy = await this.testProxy(data);
      if (!testProxy) {
        throw new BadRequestException('Invalid proxy');
      }
    }

    return this.proxyService.create(instance, data);
  }

  public async findProxy(instance: InstanceDto) {
    if (!this.waMonitor.waInstances[instance.instanceName]) {
      throw new NotFoundException(`The "${instance.instanceName}" instance does not exist`);
    }

    return this.proxyService.find(instance);
  }

  public async testProxy(proxy: ProxyDto) {
    const timeoutMs = 10000;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    let agent: ReturnType<typeof makeProxyAgent>;
    try {
      const serverIp = await axios.get('https://icanhazip.com/', {
        timeout: timeoutMs,
        signal: controller.signal,
      });
      // Axios' socket timeout alone does not cover a stalled proxy CONNECT handshake.
      agent = makeProxyAgent(proxy, controller.signal);
      const response = await axios.get('https://icanhazip.com/', {
        httpsAgent: agent,
        timeout: timeoutMs,
        signal: controller.signal,
      });

      const result = response?.data !== serverIp?.data;
      if (result) {
        logger.info('testProxy: proxy connection successful');
      } else {
        logger.warn("testProxy: proxy connection doesn't change the origin IP");
      }

      return result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('testProxy error: axios error: ' + error.message);
      } else {
        logger.error('testProxy error: unexpected error: ' + error);
      }

      return false;
    } finally {
      clearTimeout(deadline);
      controller.abort();
      agent?.destroy();
    }
  }
}
