import { InstanceDto } from '@api/dto/instance.dto';
import { SettingsDto } from '@api/dto/settings.dto';
import { Logger } from '@config/logger.config';

import { WAMonitoringService } from './monitor.service';

export class SettingsService {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  private readonly logger = new Logger('SettingsService');

  public async create(instance: InstanceDto, data: SettingsDto) {
    const runtime = this.waMonitor.waInstances[instance.instanceName];
    const existingSettings = await runtime.findSettings();
    // No settings row yet means this is the instance's very first save (e.g. during
    // instance creation). There is nothing running to restart, and comparing against an
    // empty object would make `undefined !== false` look like a change for every boolean
    // field — unconditionally triggering a managed restart (and, at creation time, an
    // auto-connect) regardless of what the caller actually asked for (see qrcode:false below).
    const isFirstSave = existingSettings === null;
    const previousSettings = existingSettings ?? {};
    const savedSettings = await runtime.setSettings(data);
    const restartFields: string[] = [];

    if (!isFirstSave) {
      if (previousSettings.alwaysOnline !== savedSettings.alwaysOnline) restartFields.push('alwaysOnline');
      if (previousSettings.syncFullHistory !== savedSettings.syncFullHistory) restartFields.push('syncFullHistory');

      const previousWavoipToken = previousSettings.wavoipToken ?? '';
      const savedWavoipToken = savedSettings.wavoipToken ?? '';
      if (previousWavoipToken !== savedWavoipToken) restartFields.push('wavoipToken');
    }

    const application: {
      mode: 'hot' | 'managed_restart';
      appliedInHot: boolean;
      restartRequired: boolean;
      restartPerformed: boolean;
      restartFields: string[];
      applied: boolean;
      error?: string;
    } = {
      mode: restartFields.length > 0 ? 'managed_restart' : 'hot',
      appliedInHot: restartFields.length === 0,
      restartRequired: restartFields.length > 0,
      restartPerformed: false,
      restartFields,
      applied: restartFields.length === 0,
    };

    if (restartFields.length > 0) {
      try {
        await this.waMonitor.reconnectInstanceNow(instance.instanceName);
        application.restartPerformed = true;
        application.applied = true;
      } catch (error) {
        // The settings row above is already persisted at this point. We deliberately do NOT
        // roll it back and do NOT throw: reverting would need a second write (which can itself
        // fail) and, when the restart failed for an external reason such as a dead proxy,
        // re-running the old settings wouldn't restore a working connection either — the
        // instance stays disconnected regardless of which settings are on record. Keeping the
        // requested settings saved but explicitly marked as not-yet-applied mirrors how the
        // rest of this codebase already treats a connection that requires manual
        // intervention: state the reality plainly instead of hiding it behind a generic 500.
        this.logger.error({
          local: 'settings.managedRestart',
          instanceName: instance.instanceName,
          restartFields,
          error,
        });
        application.applied = false;
        application.error = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      settings: { ...instance, settings: savedSettings },
      application,
    };
  }

  public async find(instance: InstanceDto): Promise<SettingsDto> {
    try {
      const result = await this.waMonitor.waInstances[instance.instanceName].findSettings();

      if (Object.keys(result).length === 0) {
        throw new Error('Settings not found');
      }

      return result;
    } catch {
      return null;
    }
  }
}
