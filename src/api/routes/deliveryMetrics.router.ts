import { DeliveryMetricsRegistry } from '@utils/deliveryMetrics';
import { RequestHandler, Router } from 'express';

/**
 * Read-only view of the in-memory delivery health kept per instance: how deep the event and webhook queues are,
 * the longest time something waited in them over the last 15 minutes, and the latest slow steps. It is built
 * from counters kept in memory, so it never queries the database and is safe to poll.
 *
 *   GET /instance/deliveryMetrics                 every instance (global API key only)
 *   GET /instance/deliveryMetrics/:instanceName   one instance (global or instance API key)
 */
export function createDeliveryMetricsRouter(
  registry: DeliveryMetricsRegistry,
  guards: { all: RequestHandler[]; one: RequestHandler[] },
): Router {
  const router = Router();

  router.get('/deliveryMetrics', ...guards.all, (_req, res) => {
    res.status(200).json({ generatedAt: new Date().toISOString(), instances: registry.snapshotAll() });
  });

  router.get('/deliveryMetrics/:instanceName', ...guards.one, (req, res) => {
    res.status(200).json(registry.forInstance(req.params.instanceName).snapshot());
  });

  return router;
}
