import type { Response } from 'express';

export function prepareJsonLineStream(response: Response) {
  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders?.();
}

export function writeJsonLine(response: Response, payload: unknown) {
  response.write(`${JSON.stringify(payload)}\n`);
}
