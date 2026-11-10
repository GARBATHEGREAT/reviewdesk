import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const duration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const end = duration.startTimer();
    res.on('finish', () => {
      // Use the route pattern (/api/tasks/:id), not the raw URL, to keep label cardinality low.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };

  return { registry, middleware };
}
