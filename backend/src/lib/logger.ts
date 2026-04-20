import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'body.authToken',
      'body.extraInstructions',
      'body.context.promptText',
      'body.instruction',
      'body.page.text',
      'body.screenshotBase64'
    ],
    censor: '[redacted]'
  }
});
